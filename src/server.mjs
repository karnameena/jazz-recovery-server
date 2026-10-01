import http from "node:http";
import crypto from "node:crypto";
import { applyMigrations, db } from "./db/database.mjs";
import { hashSecret, verifySecret } from "./auth/password.mjs";
import { createSession, sessionCookie, clearSessionCookies, getSession, destroySession } from "./auth/sessions.mjs";

applyMigrations();

const port = Number(process.env.PORT || 8890);
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production" || String(process.env.RENDER || "").toLowerCase() === "true";
const trustProxy = process.env.LOST_MODE_TRUST_PROXY == null
  ? isProduction
  : String(process.env.LOST_MODE_TRUST_PROXY).toLowerCase() === "true";
const configuredOrigins = String(
  process.env.LOST_MODE_PUBLIC_ORIGINS || process.env.LOST_MODE_PUBLIC_ORIGIN || "http://localhost:5190"
);
const ONLINE_WINDOW_MS = 90_000;
const MAX_VOICE_WAV_BYTES = 900_000;
const MAX_PENDING_COMMANDS_PER_DEVICE = 20;
const DEVICE_AUTH_CACHE_TTL_MS = 5 * 60_000;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_USER_LIMIT = 8;
const LOGIN_IP_LIMIT = 30;
const ALLOWED_COMMANDS = new Set(["DEVICE_STATUS", "GET_LOCATION", "RING_DEVICE", "RECOVERY_PHOTO", "SET_RECOVERY_MODE", "PLAY_VOICE_MESSAGE"]);
const DEDUPE_COMMANDS = new Set(["device_status", "device_location", "recovery_photo"]);
const loginAttempts = new Map();
const invalidDeviceAttempts = new Map();
const deviceAuthCache = new Map();
const dummyPasswordHash = hashSecret("Jazz-Lost-Mode-Dummy-Credential-Not-A-Login");

function normalizeOrigin(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

const publicOrigins = new Set(
  configuredOrigins
    .split(",")
    .map(value => normalizeOrigin(value))
    .filter(Boolean)
);
const primaryPublicOrigin = [...publicOrigins][0] || "http://localhost:5190";

function requestIsHttps(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return forwarded === "https" || Boolean(req.socket?.encrypted);
}

function applySecurityHeaders(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (requestIsHttps(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
}

function json(req, res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  applySecurityHeaders(req, res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

function html(req, res, status, body, nonce) {
  res.statusCode = status;
  applySecurityHeaders(req, res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'`);
  res.end(body);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", chunk => {
      if (tooLarge) return;
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        tooLarge = true;
        raw = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) return reject(new HttpError(413, "Request too large"));
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(new HttpError(400, "JSON object required"));
        }
        resolve(parsed);
      } catch (error) {
        reject(error instanceof HttpError ? error : new HttpError(400, "Invalid JSON"));
      }
    });
    req.on("error", () => reject(new HttpError(400, "Invalid request body")));
  });
}

function ipOf(req) {
  if (trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded.slice(0, 128);
  }
  return String(req.socket.remoteAddress || "unknown").slice(0, 128);
}

function pruneAttempts(map, windowMs) {
  const now = Date.now();
  for (const [key, list] of map) {
    const fresh = list.filter(ts => now - ts < windowMs);
    if (fresh.length) map.set(key, fresh);
    else map.delete(key);
  }
}

function attemptCount(map, key, windowMs) {
  const now = Date.now();
  const fresh = (map.get(key) || []).filter(ts => now - ts < windowMs);
  if (fresh.length) map.set(key, fresh);
  else map.delete(key);
  return fresh.length;
}

function recordAttempt(map, key, windowMs) {
  const now = Date.now();
  const fresh = (map.get(key) || []).filter(ts => now - ts < windowMs);
  fresh.push(now);
  map.set(key, fresh);
  if (map.size > 5000) pruneAttempts(map, windowMs);
}

function loginRateLimited(ip, username) {
  const normalized = String(username || "").toLowerCase();
  return attemptCount(loginAttempts, `user:${normalized}`, LOGIN_WINDOW_MS) >= LOGIN_USER_LIMIT ||
    attemptCount(loginAttempts, `ip:${ip}`, LOGIN_WINDOW_MS) >= LOGIN_IP_LIMIT;
}

function recordLoginFailure(ip, username) {
  const normalized = String(username || "").toLowerCase();
  recordAttempt(loginAttempts, `user:${normalized}`, LOGIN_WINDOW_MS);
  recordAttempt(loginAttempts, `ip:${ip}`, LOGIN_WINDOW_MS);
}

function clearLoginFailures(ip, username) {
  const normalized = String(username || "").toLowerCase();
  loginAttempts.delete(`user:${normalized}`);
  loginAttempts.delete(`ip:${ip}`);
}

function audit(userId, deviceId, action, status) {
  db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,?,?,?)")
    .run(userId ?? null, deviceId ?? null, action, status);
}

function ownerDevice(userId, id) {
  return db.prepare("SELECT * FROM devices WHERE id=? AND user_id=?").get(Number(id), userId);
}

function sqliteUtcToIso(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) return `${raw.replace(" ", "T")}Z`;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
}

function sqliteUtcToMs(value) {
  const normalized = sqliteUtcToIso(value);
  if (!normalized) return 0;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sqliteUtcTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

function stateFor(deviceDbId) {
  const row = db.prepare("SELECT * FROM device_state WHERE device_id=?").get(deviceDbId);
  if (!row) return null;
  const lastSeenMs = sqliteUtcToMs(row.last_seen);
  return { ...row, online: Boolean(lastSeenMs && Date.now() - lastSeenMs <= ONLINE_WINDOW_MS) };
}

function publicDevice(row) {
  const state = stateFor(row.id) || {};
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    deviceType: row.device_type,
    online: Boolean(state.online),
    mode: state.mode || "NORMAL_MODE",
    battery: state.battery,
    charging: Boolean(state.charging),
    network: state.network || "UNKNOWN",
    lastSeen: sqliteUtcToIso(state.last_seen),
    location: state.latitude == null ? null : {
      latitude: state.latitude,
      longitude: state.longitude,
      accuracyMeters: state.accuracy_meters,
      timestamp: state.location_timestamp
    },
    photo: state.photo_data_url ? {
      dataUrl: state.photo_data_url,
      camera: state.photo_camera,
      timestamp: state.photo_timestamp
    } : null
  };
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    json(req, res, 401, { ok: false, error: "Authentication required" });
    return null;
  }
  return session;
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function authenticateDevice(req) {
  const deviceId = String(req.headers["x-jazz-lost-device-id"] || "").trim();
  const token = bearer(req);
  if (!deviceId || !token || deviceId.length > 128 || token.length > 512) return null;

  const row = db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId);
  if (!row) return null;

  const ip = ipOf(req);
  const failureKey = `${row.id}:${ip}`;
  if (attemptCount(invalidDeviceAttempts, failureKey, 60_000) >= 20) return null;

  const fingerprint = crypto.createHash("sha256").update(token).digest("hex");
  const cacheKey = `${row.id}:${row.credential_hash}:${fingerprint}`;
  const cachedUntil = Number(deviceAuthCache.get(cacheKey) || 0);
  if (cachedUntil > Date.now()) return row;

  if (!verifySecret(token, row.credential_hash)) {
    recordAttempt(invalidDeviceAttempts, failureKey, 60_000);
    return null;
  }

  invalidDeviceAttempts.delete(failureKey);
  deviceAuthCache.set(cacheKey, Date.now() + DEVICE_AUTH_CACHE_TTL_MS);
  if (deviceAuthCache.size > 1000) {
    const now = Date.now();
    for (const [key, expires] of deviceAuthCache) if (expires <= now) deviceAuthCache.delete(key);
  }
  return row;
}

function validateVoiceArgs(args = {}) {
  if (args.mimeType !== "audio/wav" || typeof args.audioBase64 !== "string") return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(args.audioBase64)) return null;
  let audio;
  try { audio = Buffer.from(args.audioBase64, "base64"); } catch { return null; }
  if (audio.length <= 44 || audio.length > MAX_VOICE_WAV_BYTES) return null;
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return null;
  if (audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 || audio.readUInt16LE(34) !== 16) return null;
  return { mimeType: "audio/wav", audioBase64: args.audioBase64 };
}

function mapCommand(type, args = {}) {
  switch (type) {
    case "DEVICE_STATUS": return { type: "device_status", args: {} };
    case "GET_LOCATION": return { type: "device_location", args: {} };
    case "RING_DEVICE": return { type: "ring_device", args: { durationMs: Math.min(60_000, Math.max(5_000, Number(args.durationMs || 30_000))) } };
    case "RECOVERY_PHOTO": return { type: "recovery_photo", args: { camera: args.camera === "rear" ? "rear" : "front" } };
    case "SET_RECOVERY_MODE": return { type: "set_recovery_mode", args: { enabled: args.enabled !== false } };
    case "PLAY_VOICE_MESSAGE": {
      const voice = validateVoiceArgs(args);
      return voice ? { type: "play_voice_message", args: voice } : null;
    }
    default: return null;
  }
}

function sameCommandArgs(type, leftJson, rightArgs) {
  if (type !== "recovery_photo") return true;
  try {
    const left = JSON.parse(leftJson || "{}");
    return String(left.camera || "front") === String(rightArgs.camera || "front");
  } catch {
    return false;
  }
}

function existingPendingCommand(deviceDbId, mapped) {
  if (!DEDUPE_COMMANDS.has(mapped.type)) return null;
  const rows = db.prepare("SELECT id,args_json,leased_until FROM recovery_commands WHERE device_id=? AND type=? AND status='pending' ORDER BY created_at ASC LIMIT 12")
    .all(deviceDbId, mapped.type);
  return rows.find(item => sameCommandArgs(mapped.type, item.args_json, mapped.args)) || null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>\"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}

function serverHome(nonce) {
  const siteUrl = escapeHtml(primaryPublicOrigin);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Jazz Lost Mode Server</title>
<style nonce="${nonce}">
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:#f4f7ff;background:radial-gradient(circle at 20% 10%,#273a91 0,transparent 34rem),radial-gradient(circle at 85% 15%,#632b78 0,transparent 28rem),#050816}.card{width:min(760px,100%);padding:30px;border:1px solid rgba(142,161,238,.2);border-radius:28px;background:linear-gradient(145deg,rgba(18,27,56,.94),rgba(8,13,31,.9));box-shadow:0 30px 90px rgba(0,0,0,.42)}.brand{display:flex;align-items:center;gap:14px}.logo{width:52px;height:52px;border-radius:17px;display:grid;place-items:center;font-size:24px;background:linear-gradient(135deg,#5fe6ff,#6f8cff 42%,#a777ff 72%,#ff66c4);box-shadow:0 0 32px rgba(112,136,255,.34)}.eyebrow{font-size:12px;letter-spacing:.16em;color:#91a3ce;font-weight:800}.title{margin:3px 0 0;font-size:clamp(24px,5vw,36px);letter-spacing:-.04em}.status{display:inline-flex;align-items:center;gap:8px;margin-top:22px;padding:9px 12px;border-radius:999px;background:rgba(65,221,143,.09);border:1px solid rgba(91,240,166,.18);color:#9af7c5;font-weight:800}.dot{width:9px;height:9px;border-radius:50%;background:#67f7af;box-shadow:0 0 18px #67f7af}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:22px}.metric{padding:16px;border-radius:18px;border:1px solid rgba(136,153,218,.13);background:rgba(4,9,23,.45)}.metric span{display:block;color:#8291b4;font-size:12px}.metric strong{display:block;margin-top:6px;font-size:16px}.note{margin-top:20px;color:#93a3c8;line-height:1.6}.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:22px}a{color:#eef3ff;text-decoration:none;font-weight:800;padding:11px 14px;border-radius:13px;border:1px solid rgba(135,154,220,.2);background:rgba(11,17,38,.76)}a.primary{background:linear-gradient(100deg,#5c79ff,#8c6eff 50%,#d45dda);border:0}.foot{margin-top:24px;color:#62718f;font-size:12px}@media(max-width:620px){.card{padding:20px;border-radius:22px}.grid{grid-template-columns:1fr}.actions a{width:100%;text-align:center}}
</style></head><body><main class="card"><div class="brand"><div class="logo">✦</div><div><div class="eyebrow">JAZZ AI ASSISTANT</div><h1 class="title">Lost Mode Recovery Server</h1></div></div><div class="status"><span class="dot"></span>SERVER ONLINE</div><div class="grid"><div class="metric"><span>Browser access</span><strong>Owner authenticated</strong></div><div class="metric"><span>Device channel</span><strong>Credential protected</strong></div><div class="metric"><span>Recovery commands</span><strong>Strict allowlist</strong></div></div><p class="note">The secure recovery API is online. Operational device counts, locations, photos and pending commands are intentionally not exposed on this public status page.</p><div class="actions"><a class="primary" rel="noreferrer" href="${siteUrl}">Open Lost Mode Website</a><a href="/health">Health check</a></div><div class="foot">Jazz Lost Mode · hardened recovery transport</div></main></body></html>`;
}

function updateStateFromHeartbeat(device, input) {
  const status = input.status && typeof input.status === "object" ? input.status : {};
  const loc = input.lastKnownLocation?.ok ? input.lastKnownLocation : null;
  db.prepare(`UPDATE device_state SET mode=?,battery=?,charging=?,network=?,online=1,last_seen=CURRENT_TIMESTAMP,
    latitude=COALESCE(?,latitude),longitude=COALESCE(?,longitude),accuracy_meters=COALESCE(?,accuracy_meters),location_timestamp=COALESCE(?,location_timestamp),updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
    .run(input.mode || "NORMAL_MODE", status.battery ?? null, status.charging ? 1 : 0, status.network || "UNKNOWN",
      loc?.latitude ?? null, loc?.longitude ?? null, loc?.accuracyMeters ?? null, loc?.timestamp ?? null, device.id);
}

function updateStateFromResult(device, command, result) {
  if (!result || typeof result !== "object") return;
  if (command.type === "device_status") {
    const status = result.status || {};
    const loc = result.lastKnownLocation?.ok ? result.lastKnownLocation : null;
    db.prepare(`UPDATE device_state SET mode=?,battery=?,charging=?,network=?,last_seen=CURRENT_TIMESTAMP,
      latitude=COALESCE(?,latitude),longitude=COALESCE(?,longitude),accuracy_meters=COALESCE(?,accuracy_meters),location_timestamp=COALESCE(?,location_timestamp),updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
      .run(result.mode || "NORMAL_MODE", status.battery ?? null, status.charging ? 1 : 0, status.network || "UNKNOWN",
        loc?.latitude ?? null, loc?.longitude ?? null, loc?.accuracyMeters ?? null, loc?.timestamp ?? null, device.id);
  }
  if (command.type === "device_location" && result.ok) {
    db.prepare(`UPDATE device_state SET latitude=?,longitude=?,accuracy_meters=?,location_timestamp=?,battery=COALESCE(?,battery),network=COALESCE(?,network),last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
      .run(result.latitude, result.longitude, result.accuracyMeters ?? null, result.timestamp ?? Date.now(), result.statusSnapshot?.battery ?? null, result.statusSnapshot?.network ?? null, device.id);
  }
  if (command.type === "set_recovery_mode" && result.mode) {
    db.prepare("UPDATE device_state SET mode=?,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?").run(result.mode, device.id);
  }
  if (command.type === "recovery_photo" && result.ok && typeof result.imageBase64 === "string") {
    const mime = result.mimeType === "image/png" ? "image/png" : "image/jpeg";
    if (result.imageBase64.length <= 10 * 1024 * 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(result.imageBase64)) {
      const dataUrl = `data:${mime};base64,${result.imageBase64}`;
      db.prepare("UPDATE device_state SET photo_data_url=?,photo_camera=?,photo_timestamp=?,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?")
        .run(dataUrl, result.camera === "rear" ? "rear" : "front", result.timestamp || Date.now(), device.id);
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  const browserOrigin = req.headers.origin ? normalizeOrigin(req.headers.origin) : null;
  const originAllowed = browserOrigin ? publicOrigins.has(browserOrigin) : true;

  if (browserOrigin && originAllowed) {
    res.setHeader("Access-Control-Allow-Origin", browserOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    applySecurityHeaders(req, res);
    if (!browserOrigin || !originAllowed || !path.startsWith("/api/")) {
      res.statusCode = 403;
      return res.end();
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Max-Age", "600");
    res.statusCode = 204;
    return res.end();
  }

  if (browserOrigin && !originAllowed && (path.startsWith("/api/") || path.startsWith("/android/"))) {
    return json(req, res, 403, { ok: false, error: "Origin not allowed" });
  }
  if (browserOrigin && path.startsWith("/android/")) {
    return json(req, res, 403, { ok: false, error: "Android device endpoints are not browser endpoints" });
  }

  try {
    if (req.method === "GET" && path === "/") {
      const nonce = crypto.randomBytes(18).toString("base64");
      return html(req, res, 200, serverHome(nonce), nonce);
    }
    if (req.method === "GET" && path === "/health") {
      return json(req, res, 200, { ok: true, service: "jazz-lost-mode-server" });
    }

    if (req.method === "POST" && path === "/api/auth/login") {
      const body = await readJson(req, 32 * 1024);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const ip = ipOf(req);

      if (!username || username.length > 64 || !password || password.length > 512) {
        return json(req, res, 401, { ok: false, error: "Invalid username or password" });
      }
      if (loginRateLimited(ip, username)) {
        return json(req, res, 429, { ok: false, error: "Too many login attempts. Try again later." }, { "Retry-After": "900" });
      }

      const user = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username);
      const validPassword = verifySecret(password, user?.password_hash || dummyPasswordHash);
      if (!user || !validPassword) {
        recordLoginFailure(ip, username);
        audit(user?.id ?? null, null, "LOGIN", "FAILED");
        return json(req, res, 401, { ok: false, error: "Invalid username or password" });
      }

      clearLoginFailures(ip, username);
      const session = createSession(user.id);
      audit(user.id, null, "LOGIN", "SUCCESS");
      return json(req, res, 200, { ok: true, username: user.username, expiresAt: session.expires }, { "Set-Cookie": sessionCookie(session.token, session.expires) });
    }

    if (req.method === "POST" && path === "/api/auth/logout") {
      const session = getSession(req);
      if (session) audit(session.user_id, null, "LOGOUT", "SUCCESS");
      destroySession(req);
      return json(req, res, 200, { ok: true }, { "Set-Cookie": clearSessionCookies() });
    }

    if (req.method === "GET" && path === "/api/auth/session") {
      const session = requireSession(req, res);
      if (!session) return;
      return json(req, res, 200, { ok: true, username: session.username, expiresAt: session.expires_at });
    }

    if (req.method === "GET" && path === "/api/devices") {
      const session = requireSession(req, res); if (!session) return;
      const rows = db.prepare("SELECT * FROM devices WHERE user_id=? ORDER BY device_name").all(session.user_id);
      return json(req, res, 200, { ok: true, items: rows.map(publicDevice) });
    }

    const deviceMatch = path.match(/^\/api\/devices\/(\d+)$/);
    if (req.method === "GET" && deviceMatch) {
      const session = requireSession(req, res); if (!session) return;
      const row = ownerDevice(session.user_id, deviceMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      return json(req, res, 200, { ok: true, device: publicDevice(row) });
    }

    const actionMatch = path.match(/^\/api\/devices\/(\d+)\/actions$/);
    if (req.method === "POST" && actionMatch) {
      const session = requireSession(req, res); if (!session) return;
      const row = ownerDevice(session.user_id, actionMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      if (!ALLOWED_COMMANDS.has(action)) return json(req, res, 400, { ok: false, error: "Recovery action is not allowed" });
      const mapped = mapCommand(action, body.args || {});
      if (!mapped) return json(req, res, 400, { ok: false, error: action === "PLAY_VOICE_MESSAGE" ? "Invalid or oversized recovery voice message" : "Invalid recovery action arguments" });

      const existing = existingPendingCommand(row.id, mapped);
      if (existing) {
        audit(session.user_id, row.id, action, "COALESCED");
        return json(req, res, 202, { ok: true, commandId: existing.id, status: "ALREADY_QUEUED", deduplicated: true });
      }

      const pending = Number(db.prepare("SELECT COUNT(*) AS total FROM recovery_commands WHERE device_id=? AND status='pending'").get(row.id)?.total || 0);
      if (pending >= MAX_PENDING_COMMANDS_PER_DEVICE) {
        return json(req, res, 429, { ok: false, error: "Too many recovery commands are already pending for this device" }, { "Retry-After": "10" });
      }

      const id = crypto.randomUUID();
      db.prepare("INSERT INTO recovery_commands(id,device_id,type,args_json) VALUES(?,?,?,?)")
        .run(id, row.id, mapped.type, JSON.stringify(mapped.args));
      audit(session.user_id, row.id, action, "QUEUED");
      return json(req, res, 202, { ok: true, commandId: id, status: "QUEUED", deduplicated: false });
    }

    const auditMatch = path.match(/^\/api\/devices\/(\d+)\/audit$/);
    if (req.method === "GET" && auditMatch) {
      const session = requireSession(req, res); if (!session) return;
      const row = ownerDevice(session.user_id, auditMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      const items = db.prepare("SELECT action,status,created_at FROM recovery_audit WHERE user_id=? AND device_id=? ORDER BY id DESC LIMIT 50").all(session.user_id, row.id)
        .map(item => ({ ...item, created_at: sqliteUtcToIso(item.created_at) }));
      return json(req, res, 200, { ok: true, items });
    }

    if (req.method === "POST" && path === "/android/device/heartbeat") {
      const device = authenticateDevice(req);
      if (!device) return json(req, res, 401, { ok: false, error: "Unauthorized device" });
      const body = await readJson(req, 256 * 1024);
      if (body.deviceId && body.deviceId !== device.device_id) return json(req, res, 403, { ok: false, error: "Device identity mismatch" });
      updateStateFromHeartbeat(device, body);
      return json(req, res, 200, { ok: true, serverTime: Date.now() });
    }

    if (req.method === "GET" && path === "/android/device/commands/next") {
      const device = authenticateDevice(req);
      if (!device) return json(req, res, 401, { ok: false, error: "Unauthorized device" });
      const command = db.prepare(`SELECT * FROM recovery_commands WHERE device_id=? AND status='pending' AND (leased_until IS NULL OR leased_until<CURRENT_TIMESTAMP) ORDER BY created_at LIMIT 1`).get(device.id);
      if (!command) return json(req, res, 200, { ok: true, command: null });
      const leasedUntil = sqliteUtcTimestamp(Date.now() + 30_000);
      db.prepare("UPDATE recovery_commands SET leased_until=? WHERE id=?").run(leasedUntil, command.id);
      return json(req, res, 200, { ok: true, command: { id: command.id, type: command.type, args: JSON.parse(command.args_json || "{}"), createdAt: sqliteUtcToIso(command.created_at) } });
    }

    const resultMatch = path.match(/^\/android\/device\/commands\/([a-f0-9-]+)\/result$/i);
    if (req.method === "POST" && resultMatch) {
      const device = authenticateDevice(req);
      if (!device) return json(req, res, 401, { ok: false, error: "Unauthorized device" });
      const command = db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?").get(resultMatch[1], device.id);
      if (!command) return json(req, res, 404, { ok: false, error: "Unknown recovery command" });
      const body = await readJson(req, 8 * 1024 * 1024);
      const result = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result : {};
      db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=?")
        .run(JSON.stringify(result), command.id);
      updateStateFromResult(device, command, result);
      audit(device.user_id, device.id, command.type.toUpperCase(), result.ok === false ? "FAILED" : "SUCCESS");
      return json(req, res, 200, { ok: true });
    }

    return json(req, res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) {
      console.error(`[Jazz Lost Mode] ${req.method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const message = error instanceof HttpError ? error.message : "Lost Mode server error";
    return json(req, res, status, { ok: false, error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[Jazz Lost Mode] listening on :${port}`);
  console.log(`[Jazz Lost Mode] ${publicOrigins.size} browser origin(s) allowlisted; secure recovery transport active.`);
});
