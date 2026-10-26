import http from "node:http";
import crypto from "node:crypto";
import { applyMigrations, db } from "./database.mjs";
import { hashSecret, verifySecret, validatePassword } from "../auth/password.mjs";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";
import { createSession, sessionCookie, clearSessionCookies, getSession, destroySession } from "./sessions.mjs";
import { parsePhotoPayload, currentPhotoKey, writePhotoFile, readPhotoFile, localPhotoUrl, deletePhotoFile, localPhotoStorageReady, shouldMigrateLegacyPhoto } from "./photos.mjs";
import { handleBillingRoute, ensureDefaultDiscountCodes } from "./billing.mjs";
import { TRIAL_DAYS, getTrialConfigForUsername } from "./subscription-config.mjs";

await applyMigrations();
await ensureDefaultDiscountCodes(db);

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
const ALLOWED_COMMANDS = new Set(["DEVICE_STATUS", "GET_LOCATION", "RING_DEVICE", "RECOVERY_PHOTO", "SET_RECOVERY_MODE", "PLAY_VOICE_MESSAGE", "LOCATION_STATUS", "LOCATION_ENABLE", "LOCATION_DISABLE"]);
const LOCATION_COMMANDS = new Set(["location_status", "location_enable", "location_disable"]);
const LOCATION_WRITE_COMMANDS = new Set(["location_enable", "location_disable"]);
const LOCATION_COMMAND_TTL_MS = 120_000;
const DEDUPE_COMMANDS = new Set(["device_status", "device_location", "recovery_photo", "location_status", "location_enable", "location_disable"]);
const loginAttempts = new Map();
const recoveryAttempts = new Map();
const dummyRecoveryPinHash = hashSecret("Jazz-Recovery-Dummy-PIN-Not-A-Valid-Recovery-PIN");
const invalidDeviceAttempts = new Map();
const deviceAuthCache = new Map();
const dummyPasswordHash = hashSecret("Jazz-Lost-Mode-Dummy-Credential-Not-A-Login");

function trialClaimHash(username) {
  const normalized = String(username || "").trim().toLowerCase();
  const pepper = String(process.env.JAZZ_TRIAL_CLAIM_PEPPER || "");
  return pepper
    ? crypto.createHmac("sha256", pepper).update(normalized).digest("hex")
    : crypto.createHash("sha256").update(normalized).digest("hex");
}

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

function recoveryRateLimited(ip, username) {
  const normalized = String(username || "").toLowerCase();
  return attemptCount(recoveryAttempts, `user:${normalized}`, LOGIN_WINDOW_MS) >= 5 ||
    attemptCount(recoveryAttempts, `ip:${ip}`, LOGIN_WINDOW_MS) >= 20;
}

function recordRecoveryFailure(ip, username) {
  const normalized = String(username || "").toLowerCase();
  recordAttempt(recoveryAttempts, `user:${normalized}`, LOGIN_WINDOW_MS);
  recordAttempt(recoveryAttempts, `ip:${ip}`, LOGIN_WINDOW_MS);
}

function clearRecoveryFailures(ip, username) {
  const normalized = String(username || "").toLowerCase();
  recoveryAttempts.delete(`user:${normalized}`);
  recoveryAttempts.delete(`ip:${ip}`);
}

async function audit(userId, deviceId, action, status) {
  await db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,?,?,?)")
    .run(userId ?? null, deviceId ?? null, action, status);
}

async function ownerDevice(userId, id) {
  return await db.prepare("SELECT * FROM devices WHERE id=? AND user_id=?").get(Number(id), userId);
}

function databaseUtcToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) return `${raw.replace(" ", "T")}Z`;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? raw : new Date(parsed).toISOString();
}

function databaseUtcToMs(value) {
  const normalized = databaseUtcToIso(value);
  if (!normalized) return 0;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function databaseUtcTimestamp(ms) {
  return new Date(ms).toISOString();
}

async function stateFor(deviceDbId) {
  const row = await db.prepare("SELECT * FROM device_state WHERE device_id=?").get(deviceDbId);
  if (!row) return null;
  const lastSeenMs = databaseUtcToMs(row.last_seen);
  return { ...row, online: Boolean(lastSeenMs && Date.now() - lastSeenMs <= ONLINE_WINDOW_MS) };
}

function locationServicesState(value) {
  return value === "ON" || value === "OFF" ? value : "UNKNOWN";
}

async function migrateLegacyPhotoToLocalDisk(deviceId, legacyState) {
  if (!shouldMigrateLegacyPhoto(legacyState, legacyState.photo_data_url)) return false;
  const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(String(legacyState.photo_data_url || ""));
  if (!match) return false;
  const parsed = parsePhotoPayload(match[2], match[1]);
  const key = currentPhotoKey(deviceId, crypto.randomUUID(), parsed.extension);
  await writePhotoFile({ key, bytes: parsed.bytes, mimeType: parsed.mimeType });
  let committed = false;
  try {
    await db.transaction(async () => {
      await db.lockDevice(deviceId);
      const current = await db.prepare("SELECT photo_data_url,photo_local_path FROM device_state WHERE device_id=?").get(deviceId);
      if (!shouldMigrateLegacyPhoto(current, legacyState.photo_data_url)) return;
      await db.prepare("UPDATE device_state SET photo_local_path=?,photo_data_url=NULL,photo_mime_type=?,photo_size_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?")
        .run(key, parsed.mimeType, parsed.bytes.length, deviceId);
      committed = true;
    });
  } catch (error) {
    await cleanupLocalPhotoIfUnreferenced(key);
    throw error;
  }
  if (!committed) await cleanupLocalPhotoIfUnreferenced(key);
  return committed;
}

async function publicDevice(row) {
  let state = (await stateFor(row.id)) || {};
  if (shouldMigrateLegacyPhoto(state, state.photo_data_url) && localPhotoStorageReady()) {
    try {
      await migrateLegacyPhotoToLocalDisk(row.id, state);
      state = (await stateFor(row.id)) || state;
    } catch (error) {
      // Keep the legacy current photo intact and visible if migration cannot
      // complete. It will be retried on a later authenticated dashboard read.
      console.error("[Jazz Lost Mode] Legacy photo migration deferred:", error?.name || "error");
    }
  }
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    imei: row.imei || null,
    deviceType: row.device_type,
    online: Boolean(state.online),
    mode: state.mode || "NORMAL_MODE",
    battery: state.battery,
    charging: Boolean(state.charging),
    network: state.network || "UNKNOWN",
    lastSeen: databaseUtcToIso(state.last_seen),
    locationServices: state.online ? locationServicesState(state.location_services_status) : "OFFLINE",
    locationServicesLastConfirmed: state.location_services_timestamp || null,
    location: state.latitude == null ? null : {
      latitude: state.latitude,
      longitude: state.longitude,
      accuracyMeters: state.accuracy_meters,
      timestamp: state.location_timestamp
    },
    photo: state.photo_local_path ? {
      camera: state.photo_camera,
      timestamp: state.photo_timestamp,
      mimeType: state.photo_mime_type || "image/jpeg",
      sizeBytes: state.photo_size_bytes || null,
      available: true
    } : state.photo_data_url ? {
      dataUrl: state.photo_data_url,
      camera: state.photo_camera,
      timestamp: state.photo_timestamp,
      available: true,
      legacy: true
    } : null
  };
}

async function requireSession(req, res) {
  const session = await getSession(req);
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

async function authenticateDevice(req) {
  const deviceId = String(req.headers["x-jazz-lost-device-id"] || "").trim();
  const token = bearer(req);
  if (!deviceId || !token || deviceId.length > 128 || token.length > 512) return null;

  const row = await db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId);
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
    case "LOCATION_STATUS": return { type: "location_status", args: {} };
    case "LOCATION_ENABLE": return { type: "location_enable", args: {} };
    case "LOCATION_DISABLE": return { type: "location_disable", args: {} };
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

// Only Location Services commands expire; all existing recovery TTL behavior
// stays untouched. A command must never execute after a lost phone reconnects late.
async function expireLocationCommands(deviceDbId) {
  const deadline = databaseUtcTimestamp(Date.now() - LOCATION_COMMAND_TTL_MS);
  const expired = await db.prepare(`SELECT id,type FROM recovery_commands WHERE device_id=? AND status='pending' AND type IN ('location_enable','location_disable','location_status') AND created_at<?`).all(deviceDbId, deadline);
  if (!expired.length) return;
  const update = db.prepare("UPDATE recovery_commands SET status='expired',completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=? AND status='pending'");
  const row = await db.prepare("SELECT user_id FROM devices WHERE id=?").get(deviceDbId);
  for (const command of expired) {
    await update.run(command.id);
    await audit(row?.user_id ?? null, deviceDbId, command.type.toUpperCase(), "EXPIRED");
  }
}

async function existingPendingCommand(deviceDbId, mapped) {
  if (!DEDUPE_COMMANDS.has(mapped.type)) return null;
  const rows = await db.prepare("SELECT id,args_json,leased_until FROM recovery_commands WHERE device_id=? AND type=? AND status='pending' ORDER BY created_at ASC LIMIT 12")
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

async function updateStateFromHeartbeat(device, input) {
  const status = input.status && typeof input.status === "object" ? input.status : {};
  const loc = input.lastKnownLocation?.ok ? input.lastKnownLocation : null;
  await db.prepare(`UPDATE device_state SET mode=?,battery=?,charging=?,network=?,online=1,last_seen=CURRENT_TIMESTAMP,
    latitude=COALESCE(?,latitude),longitude=COALESCE(?,longitude),accuracy_meters=COALESCE(?,accuracy_meters),location_timestamp=COALESCE(?,location_timestamp),location_services_status=?,location_services_timestamp=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
    .run(input.mode || "NORMAL_MODE", status.battery ?? null, status.charging ? 1 : 0, status.network || "UNKNOWN",
      loc?.latitude ?? null, loc?.longitude ?? null, loc?.accuracyMeters ?? null, loc?.timestamp ?? null,
      locationServicesState(status.locationServices),
      locationServicesState(status.locationServices) === "UNKNOWN" ? null : (Number(status.locationServicesTimestamp) || Date.now()),
      device.id);
}

async function updateStateFromResult(device, command, result) {
  if (!result || typeof result !== "object") return;
  if (command.type === "device_status") {
    const status = result.status || {};
    const loc = result.lastKnownLocation?.ok ? result.lastKnownLocation : null;
    await db.prepare(`UPDATE device_state SET mode=?,battery=?,charging=?,network=?,last_seen=CURRENT_TIMESTAMP,
      latitude=COALESCE(?,latitude),longitude=COALESCE(?,longitude),accuracy_meters=COALESCE(?,accuracy_meters),location_timestamp=COALESCE(?,location_timestamp),location_services_status=?,location_services_timestamp=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
      .run(result.mode || "NORMAL_MODE", status.battery ?? null, status.charging ? 1 : 0, status.network || "UNKNOWN",
        loc?.latitude ?? null, loc?.longitude ?? null, loc?.accuracyMeters ?? null, loc?.timestamp ?? null,
      locationServicesState(status.locationServices),
      locationServicesState(status.locationServices) === "UNKNOWN" ? null : (Number(status.locationServicesTimestamp) || Date.now()),
      device.id);
  }
  if (command.type === "device_location" && result.ok) {
    await db.prepare(`UPDATE device_state SET latitude=?,longitude=?,accuracy_meters=?,location_timestamp=?,battery=COALESCE(?,battery),network=COALESCE(?,network),last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?`)
      .run(result.latitude, result.longitude, result.accuracyMeters ?? null, result.timestamp ?? Date.now(), result.statusSnapshot?.battery ?? null, result.statusSnapshot?.network ?? null, device.id);
  }
  if (LOCATION_COMMANDS.has(command.type) && result.ok === true &&
      (command.type === "location_status" ? ["ON","OFF"].includes(result.locationServices) :
        result.confirmed === true && result.locationServices === (command.type === "location_enable" ? "ON" : "OFF"))) {
    await db.prepare("UPDATE device_state SET location_services_status=?,location_services_timestamp=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?")
      .run(result.locationServices, Number(result.timestamp) || Date.now(), device.id);
  }
  if (command.type === "set_recovery_mode" && result.mode) {
    await db.prepare("UPDATE device_state SET mode=?,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?").run(result.mode, device.id);
  }

}


async function processLocalPhotoCleanupJobs() {
  if (!localPhotoStorageReady()) return;
  const jobs = await db.prepare("SELECT photo_path,attempts FROM photo_file_cleanup_jobs WHERE next_attempt_at<=CURRENT_TIMESTAMP ORDER BY created_at LIMIT 20").all();
  for (const job of jobs) {
    try {
      // Never delete an object while any device still points at it. This also
      // protects against an ambiguous database COMMIT result during recovery.
      const activeReference = await db.prepare("SELECT 1 FROM device_state WHERE photo_local_path=? LIMIT 1").get(job.photo_path);
      if (activeReference) {
        await db.prepare("DELETE FROM photo_file_cleanup_jobs WHERE photo_path=?").run(job.photo_path);
        continue;
      }
      await deletePhotoFile(job.photo_path);
      await db.prepare("DELETE FROM photo_file_cleanup_jobs WHERE photo_path=?").run(job.photo_path);
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const delaySeconds = Math.min(3600, 15 * (2 ** Math.min(attempts, 8)));
      const errorCode = String(error?.name || error?.Code || "StorageDeleteFailed").slice(0, 80);
      await db.prepare("UPDATE photo_file_cleanup_jobs SET attempts=?,next_attempt_at=CURRENT_TIMESTAMP+(? * INTERVAL '1 second'),last_error=? WHERE photo_path=?")
        .run(attempts, delaySeconds, errorCode, job.photo_path).catch(() => {});
    }
  }
}

async function cleanupLocalPhotoIfUnreferenced(key) {
  if (!key) return;
  let referenced;
  try {
    referenced = await db.prepare("SELECT 1 FROM device_state WHERE photo_local_path=? LIMIT 1").get(key);
  } catch {
    // A failed query cannot prove the object is unused. Queue it for a retry;
    // the worker rechecks references before every deletion.
    await db.prepare("INSERT INTO photo_file_cleanup_jobs(photo_path) VALUES(?) ON CONFLICT(photo_path) DO NOTHING")
      .run(key).catch(() => {});
    return;
  }
  if (referenced) return;
  try {
    await deletePhotoFile(key);
  } catch {
    await db.prepare("INSERT INTO photo_file_cleanup_jobs(photo_path) VALUES(?) ON CONFLICT(photo_path) DO NOTHING")
      .run(key).catch(() => {});
  }
}

async function completeRecoveryPhotoResult(device, commandId, result) {
  const command = await db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?").get(commandId, device.id);
  if (!command) return { status: 404, body: { ok: false, error: "Unknown recovery command" } };
  if (command.status === "done") return { status: 200, body: { ok: true, deduplicated: true } };

  const requestedCamera = JSON.parse(command.args_json || "{}").camera === "rear" ? "rear" : "front";
  if (result.ok !== true || typeof result.imageBase64 !== "string") {
    const detail = String(result.error || result.status || "Photo capture failed")
      .replace(/[\\r\\n]+/g, " ").slice(0, 160);
    await db.transaction(async () => {
      await db.lockDevice(device.id);
      await db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=? AND status='pending'")
        .run(JSON.stringify({ ok: false, error: detail, camera: requestedCamera }), command.id);
      await audit(device.user_id, device.id, "RECOVERY_PHOTO", "FAILED_CAPTURE");
    });
    return { status: 200, body: { ok: true, photoAvailable: false, error: detail } };
  }

  if (result.camera !== requestedCamera) {
    const detail = "Captured camera does not match the requested camera";
    await db.transaction(async () => {
      await db.lockDevice(device.id);
      await db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=? AND status='pending'")
        .run(JSON.stringify({ ok: false, error: detail, camera: result.camera || null }), command.id);
      await audit(device.user_id, device.id, "RECOVERY_PHOTO", "FAILED_CAMERA_MISMATCH");
    });
    return { status: 200, body: { ok: true, photoAvailable: false, error: detail } };
  }

  if (!localPhotoStorageReady()) {
    await db.transaction(async () => {
      await db.lockDevice(device.id);
      await db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=? AND status='pending'")
        .run(JSON.stringify({ ok: false, error: "Local photo storage is unavailable" }), command.id);
      await audit(device.user_id, device.id, "RECOVERY_PHOTO", "FAILED_STORAGE_CONFIG");
    });
    return { status: 200, body: { ok: true, photoAvailable: false, error: "Local photo storage is unavailable" } };
  }

  let parsed;
  try {
    parsed = parsePhotoPayload(result.imageBase64, result.mimeType);
  } catch (error) {
    await db.transaction(async () => {
      await db.lockDevice(device.id);
      await db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=? AND status='pending'")
        .run(JSON.stringify({ ok: false, error: "Invalid recovery photo" }), command.id);
      await audit(device.user_id, device.id, "RECOVERY_PHOTO", "FAILED_VALIDATION");
    });
    return { status: 200, body: { ok: true, photoAvailable: false, error: error.message } };
  }

  const key = currentPhotoKey(device.id, command.id, parsed.extension);
  await writePhotoFile({ key, bytes: parsed.bytes, mimeType: parsed.mimeType });
  let outcome;
  try {
    outcome = await db.transaction(async () => {
      await db.lockDevice(device.id);
      const currentCommand = await db.prepare("SELECT status FROM recovery_commands WHERE id=? AND device_id=?").get(command.id, device.id);
      const current = await db.prepare("SELECT photo_local_path FROM device_state WHERE device_id=?").get(device.id);
      if (!currentCommand || currentCommand.status === "done") {
        return { deduplicated: true, currentKey: current?.photo_local_path || null };
      }
      await db.prepare("UPDATE device_state SET photo_local_path=?,photo_data_url=NULL,photo_mime_type=?,photo_size_bytes=?,photo_camera=?,photo_timestamp=?,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?")
        .run(key, parsed.mimeType, parsed.bytes.length, result.camera === "rear" ? "rear" : "front", Number(result.timestamp) || Date.now(), device.id);
      await db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=? AND status='pending'")
        .run(JSON.stringify({ ok: true, camera: result.camera === "rear" ? "rear" : "front", mimeType: parsed.mimeType, sizeBytes: parsed.bytes.length, timestamp: Number(result.timestamp) || Date.now() }), command.id);
      if (current?.photo_local_path && current.photo_local_path !== key) {
        await db.prepare("INSERT INTO photo_file_cleanup_jobs(photo_path) VALUES(?) ON CONFLICT(photo_path) DO NOTHING").run(current.photo_local_path);
      }
      await audit(device.user_id, device.id, "RECOVERY_PHOTO", "SUCCESS");
      return { deduplicated: false, oldKey: current?.photo_local_path || null, currentKey: key };
    });
  } catch (error) {
    await cleanupLocalPhotoIfUnreferenced(key);
    throw error;
  }

  if (outcome.deduplicated) {
    if (outcome.currentKey !== key) await cleanupLocalPhotoIfUnreferenced(key);
    return { status: 200, body: { ok: true, deduplicated: true } };
  }
  void processLocalPhotoCleanupJobs().catch(error => console.error("[Jazz Lost Mode] Photo cleanup retry failed:", error?.name || "error"));
  return { status: 200, body: { ok: true, photoAvailable: true } };
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
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
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
    if (await handleBillingRoute({ req, res, path, db, json, readJson, requireSession })) return;

    if (req.method === "GET" && path === "/") {
      const nonce = crypto.randomBytes(18).toString("base64");
      return html(req, res, 200, serverHome(nonce), nonce);
    }
    if (req.method === "GET" && path === "/health") {
      return json(req, res, 200, { ok: true, service: "jazz-lost-mode-server" });
    }

    if (req.method === "POST" && path === "/api/auth/register") {
      const body = await readJson(req, 32 * 1024);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const confirmPassword = String(body.confirmPassword || "");
      const deviceName = String(body.deviceName || "").trim();
      const imei = String(body.imei || "").replace(/[\s-]/g, "");
      const deviceId = String(body.deviceId || "").trim();
      const deviceToken = String(body.deviceToken || "").trim();
      const recoveryPin = String(body.recoveryPin || "");
      const confirmRecoveryPin = String(body.confirmRecoveryPin || "");

      if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
        return json(req, res, 400, { ok: false, error: "Username must be 3–64 letters, numbers, dots, underscores or hyphens." });
      }
      const passwordError = validatePassword(password);
      if (passwordError) return json(req, res, 400, { ok: false, error: passwordError });
      if (password !== confirmPassword) return json(req, res, 400, { ok: false, error: "Passwords do not match." });
      if (!/^\d{4}$/.test(recoveryPin) || recoveryPin !== confirmRecoveryPin) {
        return json(req, res, 400, { ok: false, error: "Enter and confirm the same 4-digit recovery PIN." });
      }
      if (!deviceName || deviceName.length > 80) return json(req, res, 400, { ok: false, error: "Enter a device name (up to 80 characters)." });
      if (!/^\d{14,16}$/.test(imei)) return json(req, res, 400, { ok: false, error: "Enter a valid 14–16 digit IMEI." });
      if (!/^[A-Za-z0-9._:-]{3,120}$/.test(deviceId)) return json(req, res, 400, { ok: false, error: "Invalid device token ID." });
      if (deviceToken.length < 32 || deviceToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(deviceToken)) {
        return json(req, res, 400, { ok: false, error: "Generate a valid device token in the Jazz Recovery app." });
      }

      try {
        const registered = await db.transaction(async () => {
          if (await db.prepare("SELECT id FROM users WHERE LOWER(username)=LOWER(?)").get(username)) {
            return { conflict: "Username is already registered." };
          }
          if (await db.prepare("SELECT id FROM devices WHERE device_id=?").get(deviceId)) {
            return { conflict: "This device token ID is already registered." };
          }
          const user = await db.prepare("INSERT INTO users(username,password_hash,recovery_pin_hash) VALUES(?,?,?) RETURNING id")
            .get(username, hashSecret(password), hashSecret(recoveryPin));
          const device = await db.prepare("INSERT INTO devices(user_id,device_id,device_name,device_type,credential_hash,imei) VALUES(?,?,?,?,?,?) RETURNING id")
            .get(user.id, deviceId, deviceName, "Android", hashSecret(deviceToken), imei);
          await db.prepare("INSERT INTO device_state(device_id) VALUES(?)").run(device.id);
          let trialActivated = false;
          let trialStartsAt = null;
          let trialEndsAt = null;
          const userTrialConfig = getTrialConfigForUsername(username);
          const trialEnabled = userTrialConfig ? userTrialConfig.enabled : TRIAL_DAYS > 0;
          if (trialEnabled) {
            const claim = await db.prepare("INSERT INTO billing_trial_claims(username_hash,user_id) VALUES(?,?) ON CONFLICT DO NOTHING RETURNING username_hash")
              .get(trialClaimHash(username), user.id);
            if (claim) {
              const trial = userTrialConfig
                ? await db.prepare("INSERT INTO billing_trials(user_id,starts_at,expires_at) VALUES(?,?,?) RETURNING starts_at,expires_at")
                    .get(user.id, userTrialConfig.startsAt, userTrialConfig.endsAt)
                : await db.prepare("INSERT INTO billing_trials(user_id,starts_at,expires_at) VALUES(?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP + (? * INTERVAL '1 day')) RETURNING starts_at,expires_at")
                    .get(user.id, TRIAL_DAYS);
              const nowMs = Date.now();
              trialActivated = new Date(trial.starts_at).getTime() <= nowMs &&
                new Date(trial.expires_at).getTime() > nowMs;
              trialStartsAt = trial.starts_at;
              trialEndsAt = trial.expires_at;
              await audit(user.id, null, "TRIAL_ACTIVATED", "SUCCESS");
            }
          }
          await audit(user.id, device.id, "DEVICE_REGISTER", "SUCCESS");
          return { userId: user.id, deviceId: device.id, trialActivated, trialStartsAt, trialEndsAt };
        });
        if (registered.conflict) return json(req, res, 409, { ok: false, error: registered.conflict });
        const session = await createSession(registered.userId);
        return json(req, res, 201, {
          ok: true,
          username,
          trialActivated: registered.trialActivated,
          trial: registered.trialActivated ? { startsAt: registered.trialStartsAt, expiresAt: registered.trialEndsAt } : null,
          device: { id: registered.deviceId, deviceId, deviceName, imei, deviceType: "Android" },
          expiresAt: session.expires
        }, { "Set-Cookie": sessionCookie(session.token, session.expires) });
      } catch (error) {
        if (error?.code === "23505") return json(req, res, 409, { ok: false, error: "Username or device is already registered." });
        throw error;
      }
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

      const user = await db.prepare("SELECT * FROM users WHERE LOWER(username)=LOWER(?)").get(username);
      const validPassword = verifySecret(password, user?.password_hash || dummyPasswordHash);
      if (!user || !validPassword) {
        recordLoginFailure(ip, username);
        await audit(user?.id ?? null, null, "LOGIN", "FAILED");
        return json(req, res, 401, { ok: false, error: "Invalid username or password" });
      }

      clearLoginFailures(ip, username);
      const session = await createSession(user.id);
      await audit(user.id, null, "LOGIN", "SUCCESS");
      return json(req, res, 200, { ok: true, username: user.username, expiresAt: session.expires }, { "Set-Cookie": sessionCookie(session.token, session.expires) });
    }

    if (req.method === "POST" && path === "/api/auth/recovery-pin") {
      const session = await requireSession(req, res);
      if (!session) return;
      const body = await readJson(req, 16 * 1024);
      const password = String(body.password || "");
      const recoveryPin = String(body.recoveryPin || "");
      const confirmRecoveryPin = String(body.confirmRecoveryPin || "");
      if (!/^\d{4}$/.test(recoveryPin) || recoveryPin !== confirmRecoveryPin) {
        return json(req, res, 400, { ok: false, error: "Enter and confirm the same 4-digit recovery PIN." });
      }
      const user = await db.prepare("SELECT * FROM users WHERE id=?").get(session.user_id);
      if (!user || !verifySecret(password, user.password_hash)) {
        return json(req, res, 401, { ok: false, error: "Current password is incorrect." });
      }
      await db.transaction(async () => {
        await db.prepare("UPDATE users SET recovery_pin_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(hashSecret(recoveryPin), session.user_id);
        await audit(session.user_id, null, "RECOVERY_PIN_SET", "SUCCESS");
      });
      return json(req, res, 200, { ok: true, message: "Recovery PIN saved securely." });
    }

    if (req.method === "POST" && path === "/api/auth/forgot-password") {
      const body = await readJson(req, 16 * 1024);
      const username = String(body.username || "").trim();
      const recoveryPin = String(body.recoveryPin || "");
      const newPassword = String(body.newPassword || "");
      const ip = ipOf(req);
      if (!username || username.length > 64 || !/^\d{4}$/.test(recoveryPin)) {
        return json(req, res, 400, { ok: false, error: "Unable to verify recovery details. Check the username and 4-digit PIN." });
      }
      if (recoveryRateLimited(ip, username)) {
        return json(req, res, 429, { ok: false, error: "Too many recovery attempts. Try again later." }, { "Retry-After": "900" });
      }
      const passwordError = validatePassword(newPassword);
      if (passwordError) return json(req, res, 400, { ok: false, error: passwordError });
      const user = await db.prepare("SELECT id,username,recovery_pin_hash FROM users WHERE LOWER(username)=LOWER(?)").get(username);
      const validPin = verifySecret(recoveryPin, user?.recovery_pin_hash || dummyRecoveryPinHash);
      if (!user || !user.recovery_pin_hash || !validPin) {
        recordRecoveryFailure(ip, username);
        await audit(user?.id ?? null, null, "PASSWORD_RESET", "FAILED");
        return json(req, res, 400, { ok: false, error: "Unable to verify recovery details. Check the username and 4-digit PIN, or use another recovery method." });
      }
      await db.transaction(async () => {
        await db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(hashSecret(newPassword), user.id);
        await db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
        await audit(user.id, null, "PASSWORD_RESET", "SUCCESS");
      });
      clearRecoveryFailures(ip, username);
      return json(req, res, 200, { ok: true, message: "Password reset successful. Sign in with your new password." }, { "Set-Cookie": clearSessionCookies() });
    }

    if (req.method === "POST" && path === "/api/auth/device-repair") {
      const body = await readJson(req, 32 * 1024);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const deviceId = String(body.deviceId || "").trim();
      const deviceToken = String(body.deviceToken || "").trim();
      const deviceName = String(body.deviceName || "").trim();
      const imei = String(body.imei || "").replace(/[\s-]/g, "");
      const ip = ipOf(req);

      if (!username || username.length > 64 || !password || password.length > 512 ||
          !deviceId || deviceId.length > 128 || deviceToken.length < 32 ||
          deviceToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(deviceToken)) {
        return json(req, res, 400, { ok: false, error: "Username, password, existing device ID and a new device token are required." });
      }
      if (loginRateLimited(ip, username)) {
        return json(req, res, 429, { ok: false, error: "Too many attempts. Try again later." }, { "Retry-After": "900" });
      }

      const user = await db.prepare("SELECT * FROM users WHERE LOWER(username)=LOWER(?)").get(username);
      const validPassword = verifySecret(password, user?.password_hash || dummyPasswordHash);
      if (!user || !validPassword) {
        recordLoginFailure(ip, username);
        await audit(user?.id ?? null, null, "DEVICE_REPAIR", "FAILED_AUTH");
        return json(req, res, 401, { ok: false, error: "Invalid username or password." });
      }

      const device = await db.prepare("SELECT * FROM devices WHERE user_id=? AND device_id=?").get(user.id, deviceId);
      if (!device) {
        await audit(user.id, null, "DEVICE_REPAIR", "DEVICE_NOT_OWNED");
        return json(req, res, 404, { ok: false, error: "That existing device ID is not registered to this account." });
      }

      const cleanName = deviceName.slice(0, 80);
      const cleanImei = /^\d{14,20}$/.test(imei) ? imei : "";
      await db.prepare("UPDATE devices SET credential_hash=?,device_name=COALESCE(NULLIF(?,''),device_name),imei=COALESCE(NULLIF(?,''),imei),updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?")
        .run(hashSecret(deviceToken), cleanName, cleanImei, device.id, user.id);
      for (const key of deviceAuthCache.keys()) {
        if (key.startsWith(String(device.id) + ":")) deviceAuthCache.delete(key);
      }
      clearLoginFailures(ip, username);
      await audit(user.id, device.id, "DEVICE_REPAIR", "SUCCESS");
      return json(req, res, 200, { ok: true, deviceId, message: "Existing device record re-paired. Its history and recovery state were preserved." });
    }

    if (req.method === "POST" && path === "/api/auth/passkey/register/options") {
      const session = await requireSession(req, res);
      if (!session) return;
      const user = await db.prepare("SELECT id,username FROM users WHERE id=?").get(session.user_id);
      if (!user) return json(req, res, 401, { ok: false, error: "Authentication required" });

      const rpOrigin = process.env.JAZZ_WEBAUTHN_ORIGIN || primaryPublicOrigin;
      const rpID = process.env.JAZZ_WEBAUTHN_RP_ID || new URL(rpOrigin).hostname;
      const existing = await db.prepare("SELECT credential_id,transports_json FROM passkey_credentials WHERE user_id=?").all(user.id);
      const options = await generateRegistrationOptions({
        rpName: "Jazz Recovery",
        rpID,
        userID: new Uint8Array(Buffer.from(String(user.id), "utf8")),
        userName: user.username,
        userDisplayName: user.username,
        attestationType: "none",
        excludeCredentials: existing.map(item => ({
          id: item.credential_id,
          transports: JSON.parse(item.transports_json || "[]")
        })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        timeout: 60000
      });

      await db.prepare("DELETE FROM passkey_challenges WHERE expires_at <= CURRENT_TIMESTAMP").run();
      const flowId = crypto.randomUUID();
      await db.prepare("INSERT INTO passkey_challenges(id,user_id,challenge,kind,expires_at) VALUES(?,?,?,'register',?)")
        .run(flowId, user.id, options.challenge, new Date(Date.now() + 5 * 60_000).toISOString());
      return json(req, res, 200, { ok: true, flowId, options });
    }

    if (req.method === "POST" && path === "/api/auth/passkey/register/verify") {
      const session = await requireSession(req, res);
      if (!session) return;
      const body = await readJson(req, 128 * 1024);
      const flowId = String(body.flowId || "");
      const challengeRow = await db.prepare("SELECT * FROM passkey_challenges WHERE id=? AND user_id=? AND kind='register' AND expires_at>CURRENT_TIMESTAMP")
        .get(flowId, session.user_id);
      if (!challengeRow) {
        await db.prepare("DELETE FROM passkey_challenges WHERE id=? AND user_id=? AND kind='register'").run(flowId, session.user_id);
        return json(req, res, 400, { ok: false, error: "Passkey setup expired. Please try again." });
      }

      const rpOrigin = process.env.JAZZ_WEBAUTHN_ORIGIN || primaryPublicOrigin;
      const rpID = process.env.JAZZ_WEBAUTHN_RP_ID || new URL(rpOrigin).hostname;
      const verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: rpOrigin,
        expectedRPID: rpID,
        requireUserVerification: true
      });
      if (!verification.verified || !verification.registrationInfo) {
        await db.prepare("DELETE FROM passkey_challenges WHERE id=? AND user_id=? AND kind='register'").run(flowId, session.user_id);
        await audit(session.user_id, null, "PASSKEY_REGISTER", "FAILED");
        return json(req, res, 400, { ok: false, error: "Passkey verification failed." });
      }

      const credential = verification.registrationInfo.credential;
      const saved = await db.transaction(async () => {
        const consumed = await db.prepare("DELETE FROM passkey_challenges WHERE id=? AND user_id=? AND kind='register' AND expires_at>CURRENT_TIMESTAMP")
          .run(flowId, session.user_id);
        if (consumed.changes !== 1) return false;
        const inserted = await db.prepare("INSERT INTO passkey_credentials(credential_id,user_id,public_key,counter,transports_json) VALUES(?,?,?,?,?) ON CONFLICT (credential_id) DO NOTHING")
          .run(credential.id, session.user_id, Buffer.from(credential.publicKey).toString("base64url"),
            Number(credential.counter || 0),
            JSON.stringify(credential.transports || body.response?.response?.transports || []));
        if (inserted.changes !== 1) return false;
        await audit(session.user_id, null, "PASSKEY_REGISTER", "SUCCESS");
        return true;
      });
      if (!saved) return json(req, res, 409, { ok: false, error: "This passkey was already registered or the setup request expired. Start again." });
      return json(req, res, 200, { ok: true });
    }

    if (req.method === "POST" && (path === "/api/auth/password-reset/passkey/options" || path === "/api/auth/passkey/options")) {
      const body = await readJson(req, 16 * 1024);
      const username = String(body.username || "").trim();
      const ip = ipOf(req);
      if (recoveryRateLimited(ip, username)) {
        return json(req, res, 429, { ok: false, error: "Too many recovery attempts. Try again later." }, { "Retry-After": "900" });
      }

      const user = username && username.length <= 64
        ? await db.prepare("SELECT id,username FROM users WHERE LOWER(username)=LOWER(?)").get(username)
        : null;
      const rpOrigin = process.env.JAZZ_WEBAUTHN_ORIGIN || primaryPublicOrigin;
      const rpID = process.env.JAZZ_WEBAUTHN_RP_ID || new URL(rpOrigin).hostname;
      const credentials = user
        ? await db.prepare("SELECT credential_id,transports_json FROM passkey_credentials WHERE user_id=?").all(user.id)
        : [];
      if (!credentials.length) {
        return json(req, res, 200, {
          ok: true,
          available: false,
          message: "No registered passkey is available for this account. Use your recovery PIN or sign in to register a passkey."
        });
      }

      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: credentials.map(item => ({
          id: item.credential_id,
          transports: JSON.parse(item.transports_json || "[]")
        })),
        userVerification: "required",
        timeout: 60000
      });
      await db.prepare("DELETE FROM passkey_challenges WHERE expires_at <= CURRENT_TIMESTAMP").run();
      const flowId = crypto.randomUUID();
      await db.prepare("INSERT INTO passkey_challenges(id,user_id,challenge,kind,expires_at) VALUES(?,?,?,'reset',?)")
        .run(flowId, user.id, options.challenge, new Date(Date.now() + 5 * 60_000).toISOString());
      return json(req, res, 200, { ok: true, available: true, flowId, options });
    }

    if (req.method === "POST" && (path === "/api/auth/password-reset/passkey/verify" || path === "/api/auth/passkey/verify")) {
      const body = await readJson(req, 128 * 1024);
      const flowId = String(body.flowId || "");
      const newPassword = String(body.newPassword || "");
      const passwordError = validatePassword(newPassword);
      const ip = ipOf(req);
      if (passwordError) return json(req, res, 400, { ok: false, error: passwordError });

      const challengeRow = await db.prepare("SELECT * FROM passkey_challenges WHERE id=? AND kind='reset' AND expires_at>CURRENT_TIMESTAMP")
        .get(flowId);
      if (!challengeRow) {
        await db.prepare("DELETE FROM passkey_challenges WHERE id=? AND kind='reset'").run(flowId);
        return json(req, res, 400, { ok: false, error: "Passkey reset expired. Start again." });
      }

      const credentialId = String(body.response?.id || "");
      const credential = await db.prepare("SELECT * FROM passkey_credentials WHERE credential_id=? AND user_id=?")
        .get(credentialId, challengeRow.user_id);
      if (!credential) {
        await db.prepare("DELETE FROM passkey_challenges WHERE id=? AND kind='reset'").run(flowId);
        recordRecoveryFailure(ip, String(challengeRow.user_id));
        await audit(challengeRow.user_id, null, "PASSWORD_RESET_PASSKEY", "FAILED_CREDENTIAL");
        return json(req, res, 401, { ok: false, error: "Passkey could not be verified." });
      }

      const rpOrigin = process.env.JAZZ_WEBAUTHN_ORIGIN || primaryPublicOrigin;
      const rpID = process.env.JAZZ_WEBAUTHN_RP_ID || new URL(rpOrigin).hostname;
      const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challengeRow.challenge,
        expectedOrigin: rpOrigin,
        expectedRPID: rpID,
        credential: {
          id: credential.credential_id,
          publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64url")),
          counter: Number(credential.counter || 0),
          transports: JSON.parse(credential.transports_json || "[]")
        },
        requireUserVerification: true
      });
      if (!verification.verified) {
        await db.prepare("DELETE FROM passkey_challenges WHERE id=? AND kind='reset'").run(flowId);
        recordRecoveryFailure(ip, String(challengeRow.user_id));
        await audit(challengeRow.user_id, null, "PASSWORD_RESET_PASSKEY", "FAILED_VERIFICATION");
        return json(req, res, 401, { ok: false, error: "Passkey could not be verified." });
      }

      const saved = await db.transaction(async () => {
        const consumed = await db.prepare("DELETE FROM passkey_challenges WHERE id=? AND user_id=? AND kind='reset' AND expires_at>CURRENT_TIMESTAMP")
          .run(flowId, challengeRow.user_id);
        if (consumed.changes !== 1) return false;
        await db.prepare("UPDATE passkey_credentials SET counter=?,last_used_at=CURRENT_TIMESTAMP WHERE credential_id=? AND user_id=?")
          .run(Number(verification.authenticationInfo.newCounter || 0), credential.credential_id, challengeRow.user_id);
        await db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(hashSecret(newPassword), challengeRow.user_id);
        await db.prepare("DELETE FROM sessions WHERE user_id=?").run(challengeRow.user_id);
        await audit(challengeRow.user_id, null, "PASSWORD_RESET_PASSKEY", "SUCCESS");
        return true;
      });
      if (!saved) return json(req, res, 400, { ok: false, error: "Passkey reset expired or was already used. Start again." });
      clearRecoveryFailures(ip, String(challengeRow.user_id));
      return json(req, res, 200, { ok: true, message: "Password reset successful. Sign in with your new password." }, { "Set-Cookie": clearSessionCookies() });
    }

    if (req.method === "POST" && path === "/api/auth/logout") {
      const session = await getSession(req);
      if (session) await audit(session.user_id, null, "LOGOUT", "SUCCESS");
      await destroySession(req);
      return json(req, res, 200, { ok: true }, { "Set-Cookie": clearSessionCookies() });
    }

    if (req.method === "GET" && path === "/api/auth/session") {
      const session = await requireSession(req, res);
      if (!session) return;
      return json(req, res, 200, { ok: true, username: session.username, expiresAt: session.expires_at });
    }

    if (req.method === "GET" && path === "/api/devices") {
      const session = await requireSession(req, res); if (!session) return;
      const rows = await db.prepare("SELECT * FROM devices WHERE user_id=? ORDER BY device_name").all(session.user_id);
      return json(req, res, 200, { ok: true, items: await Promise.all(rows.map(publicDevice)) });
    }

    const deviceMatch = path.match(/^\/api\/devices\/(\d+)$/);
    if (req.method === "GET" && deviceMatch) {
      const session = await requireSession(req, res); if (!session) return;
      const row = await ownerDevice(session.user_id, deviceMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      return json(req, res, 200, { ok: true, device: await publicDevice(row) });
    }

    const photoContentMatch = path.match(/^\/api\/devices\/(\d+)\/photo-content$/);
    if (req.method === "GET" && photoContentMatch) {
      const session = await requireSession(req, res); if (!session) return;
      const row = await ownerDevice(session.user_id, photoContentMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });

      let state = await db.prepare("SELECT photo_local_path,photo_data_url,photo_mime_type,photo_size_bytes,photo_camera,photo_timestamp FROM device_state WHERE device_id=?").get(row.id);
      if (!state?.photo_local_path && !state?.photo_data_url) {
        return json(req, res, 404, { ok: false, error: "No current recovery photo" });
      }

      // One-time, lazy migration for a legacy current photo stored as a data URL
      // in PostgreSQL. Upload first; clear the database bytes only after the new
      // local file is safely committed as the current reference.
      if (shouldMigrateLegacyPhoto(state, state.photo_data_url) && localPhotoStorageReady()) {
        const legacyDataUrl = state.photo_data_url;
        try {
          const legacyMatch = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(legacyDataUrl);
          if (!legacyMatch) throw new Error("Stored legacy photo is invalid");
          const legacyPhoto = parsePhotoPayload(legacyMatch[2], legacyMatch[1]);
          const migrationCommandId = crypto.randomUUID();
          const migrationKey = currentPhotoKey(row.id, migrationCommandId, legacyPhoto.extension);
          await writePhotoFile({ key: migrationKey, bytes: legacyPhoto.bytes, mimeType: legacyPhoto.mimeType });
          let committed = false;
          try {
            committed = await db.transaction(async () => {
              await db.lockDevice(row.id);
              const latest = await db.prepare("SELECT photo_local_path,photo_data_url FROM device_state WHERE device_id=?").get(row.id);
              if (!latest || latest.photo_local_path || latest.photo_data_url !== legacyDataUrl) return false;
              await db.prepare("UPDATE device_state SET photo_local_path=?,photo_data_url=NULL,photo_mime_type=?,photo_size_bytes=?,updated_at=CURRENT_TIMESTAMP WHERE device_id=?")
                .run(migrationKey, legacyPhoto.mimeType, legacyPhoto.bytes.length, row.id);
              return true;
            });
          } catch (error) {
            await cleanupLocalPhotoIfUnreferenced(migrationKey);
            throw error;
          }
          if (!committed) {
            await cleanupLocalPhotoIfUnreferenced(migrationKey);
          }
          state = await db.prepare("SELECT photo_local_path,photo_data_url,photo_mime_type,photo_size_bytes,photo_camera,photo_timestamp FROM device_state WHERE device_id=?").get(row.id);
        } catch (error) {
          // Migration is opportunistic: retain and serve the legacy current
          // photo if storage is temporarily unavailable. Never erase it first.
          console.error("[Jazz Lost Mode] Legacy photo migration deferred:", error?.name || "error");
          state = await db.prepare("SELECT photo_local_path,photo_data_url,photo_mime_type,photo_size_bytes,photo_camera,photo_timestamp FROM device_state WHERE device_id=?").get(row.id);
        }
      }

      if (!state?.photo_local_path && !state?.photo_data_url) {
        return json(req, res, 404, { ok: false, error: "No current recovery photo" });
      }

      let bytes;
      let mimeType;
      try {
        if (state.photo_local_path) {
          const object = await readPhotoFile(state.photo_local_path);
          if (!object?.Body) throw new Error("Current photo file is empty");
          const rawBytes = await object.Body.transformToByteArray();
          const candidate = Buffer.from(rawBytes);
          if (!candidate.length || candidate.length > 5 * 1024 * 1024) throw new Error("Current photo size is invalid");
          const declaredMime = state.photo_mime_type || object.ContentType ||
            (state.photo_local_path.endsWith(".png") ? "image/png" : "image/jpeg");
          const parsed = parsePhotoPayload(candidate.toString("base64"), declaredMime);
          bytes = parsed.bytes;
          mimeType = parsed.mimeType;
        } else {
          const match = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(state.photo_data_url);
          if (!match) throw new Error("Stored legacy photo is invalid");
          const parsed = parsePhotoPayload(match[2], match[1]);
          bytes = parsed.bytes;
          mimeType = parsed.mimeType;
        }
      } catch (error) {
        console.error("[Jazz Lost Mode] Current photo read/validation failed:", error?.name || "error");
        return json(req, res, 502, { ok: false, error: "The current photo could not be read or is not a valid JPEG/PNG. Capture a new photo and try again." });
      }

      applySecurityHeaders(req, res);
      res.statusCode = 200;
      res.setHeader("Content-Type", mimeType);
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Content-Disposition", (url.searchParams.get("download") === "1" ? "attachment" : "inline") + "; filename=\"jazz-recovery-current." + (mimeType === "image/png" ? "png" : "jpg") + "\"");
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.end(bytes);
      return;
    }

    const photoUrlMatch = path.match(/^\/api\/devices\/(\d+)\/photo-url$/);
    if (req.method === "GET" && photoUrlMatch) {
      const session = await requireSession(req, res); if (!session) return;
      const row = await ownerDevice(session.user_id, photoUrlMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      const state = await db.prepare("SELECT photo_local_path,photo_data_url FROM device_state WHERE device_id=?").get(row.id);
      if (state?.photo_data_url) return json(req, res, 200, { ok: true, url: state.photo_data_url, legacy: true });
      if (!state?.photo_local_path) return json(req, res, 404, { ok: false, error: "No current recovery photo" });
      const scheme = String(req.headers["x-forwarded-proto"] || (req.socket?.encrypted ? "https" : "http")).split(",")[0].trim();
      const base = scheme + "://" + String(req.headers.host || "localhost");
      return json(req, res, 200, { ok: true, url: base + "/api/devices/" + row.id + "/photo-content" + (url.searchParams.get("download") === "1" ? "?download=1" : "") });
    }

    const photoDeleteMatch = path.match(/^\/api\/devices\/(\d+)\/photo$/);
    if (req.method === "DELETE" && photoDeleteMatch) {
      const session = await requireSession(req, res); if (!session) return;
      const row = await ownerDevice(session.user_id, photoDeleteMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      await db.transaction(async () => {
        await db.lockDevice(row.id);
        const state = await db.prepare("SELECT photo_local_path FROM device_state WHERE device_id=?").get(row.id);
        await db.prepare("UPDATE device_state SET photo_local_path=NULL,photo_data_url=NULL,photo_mime_type=NULL,photo_size_bytes=NULL,photo_camera=NULL,photo_timestamp=NULL,updated_at=CURRENT_TIMESTAMP WHERE device_id=?").run(row.id);
        if (state?.photo_local_path) {
          await db.prepare("INSERT INTO photo_file_cleanup_jobs(photo_path) VALUES(?) ON CONFLICT(photo_path) DO NOTHING").run(state.photo_local_path);
        }
        await audit(session.user_id, row.id, "DELETE_CURRENT_RECOVERY_PHOTO", "SUCCESS");
      });
      void processLocalPhotoCleanupJobs().catch(error => console.error("[Jazz Lost Mode] Photo cleanup retry failed:", error?.name || "error"));
      return json(req, res, 200, { ok: true, photoAvailable: false });
    }

    const actionMatch = path.match(/^\/api\/devices\/(\d+)\/actions$/);
    if (req.method === "POST" && actionMatch) {
      const session = await requireSession(req, res); if (!session) return;
      const row = await ownerDevice(session.user_id, actionMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      if (!ALLOWED_COMMANDS.has(action)) return json(req, res, 400, { ok: false, error: "Recovery action is not allowed" });
      const mapped = mapCommand(action, body.args || {});
      if (!mapped) return json(req, res, 400, { ok: false, error: action === "PLAY_VOICE_MESSAGE" ? "Invalid or oversized recovery voice message" : "Invalid recovery action arguments" });

      const response = await db.transaction(async () => {
        await db.lockDevice(row.id);
      if (LOCATION_COMMANDS.has(mapped.type)) {
        await expireLocationCommands(row.id);
        if (LOCATION_WRITE_COMMANDS.has(mapped.type)) {
          const conflict = await db.prepare(`SELECT id,type FROM recovery_commands WHERE device_id=? AND status='pending' AND type IN ('location_enable','location_disable') AND type<>? LIMIT 1`)
            .get(row.id, mapped.type);
          if (conflict) {
            await audit(session.user_id, row.id, action, "CONFLICT");
            return { status: 409, body: { ok: false, error: "An opposite Location Services command is already pending. Refresh its result before changing direction." } };
          }
        }
      }
      const existing = await existingPendingCommand(row.id, mapped);
      if (existing) {
        await audit(session.user_id, row.id, action, "COALESCED");
        return { status: 202, body: { ok: true, commandId: existing.id, status: "ALREADY_QUEUED", deduplicated: true } };
      }

      const pending = Number((await db.prepare("SELECT COUNT(*) AS total FROM recovery_commands WHERE device_id=? AND status='pending'").get(row.id))?.total || 0);
      if (pending >= MAX_PENDING_COMMANDS_PER_DEVICE) {
        return { status: 429, body: { ok: false, error: "Too many recovery commands are already pending for this device" }, headers: { "Retry-After": "10" } };
      }

      const id = crypto.randomUUID();
      await db.prepare("INSERT INTO recovery_commands(id,device_id,type,args_json) VALUES(?,?,?,?)")
        .run(id, row.id, mapped.type, JSON.stringify(mapped.args));
      await audit(session.user_id, row.id, action, "QUEUED");
      return { status: 202, body: { ok: true, commandId: id, status: "QUEUED", deduplicated: false } };
      });
      return json(req, res, response.status, response.body, response.headers || {});
    }

    // Command status is readable only by the authenticated owner of the enrolled device.
    // Support every command type; the former location-only guard returned 404 for photo commands.
    const commandStatusMatch = path.match(/^\/api\/devices\/(\d+)\/commands\/([a-f0-9-]{36})$/i);
    if (req.method === "GET" && commandStatusMatch) {
      const session = await requireSession(req, res); if (!session) return;
      const row = await ownerDevice(session.user_id, commandStatusMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      const command = await db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?")
        .get(commandStatusMatch[2], row.id);
      if (!command) return json(req, res, 404, { ok: false, error: "Command not found" });
      if (LOCATION_COMMANDS.has(command.type)) await expireLocationCommands(row.id);
      const refreshed = await db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?")
        .get(command.id, row.id);
      if (!refreshed) return json(req, res, 404, { ok: false, error: "Command not found" });
      const outcome = refreshed.result_json ? JSON.parse(refreshed.result_json) : null;
      const desired = refreshed.type === "location_enable" ? "ON" :
        refreshed.type === "location_disable" ? "OFF" : null;
      const confirmed = LOCATION_COMMANDS.has(refreshed.type) &&
        refreshed.status === "done" && outcome?.ok === true &&
        (desired ? outcome.confirmed === true && outcome.locationServices === desired :
          ["ON", "OFF"].includes(outcome.locationServices));
      const state = await stateFor(row.id);
      const status = LOCATION_COMMANDS.has(refreshed.type)
        ? (confirmed ? "CONFIRMED" :
            refreshed.status === "expired" ? "EXPIRED" :
            refreshed.status === "done" ? "FAILED" :
            state?.online ? "PENDING" : "DEVICE_OFFLINE")
        : (refreshed.status === "expired" ? "EXPIRED" :
            refreshed.status === "done" ? (outcome?.ok === false ? "FAILED" : "COMPLETE") :
            state?.online ? "PENDING" : "DEVICE_OFFLINE");
      // Never return photo bytes through status polling. Photo results contain metadata only.
      return json(req, res, 200, { ok: true, commandId: refreshed.id, status,
        confirmed, command: refreshed.type, result: outcome,
        createdAt: databaseUtcToIso(refreshed.created_at),
        completedAt: databaseUtcToIso(refreshed.completed_at) });
    }

    const auditMatch = path.match(/^\/api\/devices\/(\d+)\/audit$/);
    if (req.method === "GET" && auditMatch) {
      const session = await requireSession(req, res); if (!session) return;
      const row = await ownerDevice(session.user_id, auditMatch[1]);
      if (!row) return json(req, res, 404, { ok: false, error: "Device not found" });
      const items = (await db.prepare("SELECT action,status,created_at FROM recovery_audit WHERE user_id=? AND device_id=? ORDER BY id DESC LIMIT 50").all(session.user_id, row.id))
        .map(item => ({ ...item, created_at: databaseUtcToIso(item.created_at) }));
      return json(req, res, 200, { ok: true, items });
    }

    if (req.method === "POST" && path === "/android/device/heartbeat") {
      const device = await authenticateDevice(req);
      if (!device) return json(req, res, 401, { ok: false, error: "Unauthorized device" });
      const body = await readJson(req, 256 * 1024);
      if (body.deviceId && body.deviceId !== device.device_id) return json(req, res, 403, { ok: false, error: "Device identity mismatch" });
      await updateStateFromHeartbeat(device, body);
      return json(req, res, 200, { ok: true, serverTime: Date.now() });
    }

    if (req.method === "GET" && path === "/android/device/commands/next") {
      const device = await authenticateDevice(req);
      if (!device) return json(req, res, 401, { ok: false, error: "Unauthorized device" });
      const command = await db.transaction(async () => {
        await db.lockDevice(device.id);
        await expireLocationCommands(device.id);
        const next = await db.prepare(`SELECT * FROM recovery_commands WHERE device_id=? AND status='pending' AND (leased_until IS NULL OR leased_until<CURRENT_TIMESTAMP) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`).get(device.id);
        if (!next) return null;
        const leasedUntil = databaseUtcTimestamp(Date.now() + 30_000);
        await db.prepare("UPDATE recovery_commands SET leased_until=? WHERE id=?").run(leasedUntil, next.id);
        return next;
      });
      if (!command) return json(req, res, 200, { ok: true, command: null });
      const createdAtMs = databaseUtcToMs(command.created_at);
      return json(req, res, 200, { ok: true, command: {
        id: command.id, type: command.type, args: JSON.parse(command.args_json || "{}"),
        createdAt: databaseUtcToIso(command.created_at),
        ...(LOCATION_COMMANDS.has(command.type)
          ? { createdAtMs, expiresAtMs: createdAtMs + LOCATION_COMMAND_TTL_MS }
          : {})
      } });
    }

    const resultMatch = path.match(/^\/android\/device\/commands\/([a-f0-9-]+)\/result$/i);
    if (req.method === "POST" && resultMatch) {
      const device = await authenticateDevice(req);
      if (!device) return json(req, res, 401, { ok: false, error: "Unauthorized device" });
      const body = await readJson(req, 8 * 1024 * 1024);
      const result = body.result && typeof body.result === "object" && !Array.isArray(body.result) ? body.result : {};
      const photoCommand = await db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?").get(resultMatch[1], device.id);
      if (!photoCommand) return json(req, res, 404, { ok: false, error: "Unknown recovery command" });
      if (photoCommand.type === "recovery_photo") {
        const photoResponse = await completeRecoveryPhotoResult(device, resultMatch[1], result);
        return json(req, res, photoResponse.status, photoResponse.body);
      }
      const response = await db.transaction(async () => {
        await db.lockDevice(device.id);
      const command = await db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?").get(resultMatch[1], device.id);
      if (!command) return { status: 404, body: { ok: false, error: "Unknown recovery command" } };
      if (LOCATION_COMMANDS.has(command.type)) {
        await expireLocationCommands(device.id);
        const refreshed = await db.prepare("SELECT status FROM recovery_commands WHERE id=?").get(command.id);
        if (refreshed?.status === "expired") return { status: 409, body: { ok: false, error: "Location Services command expired" } };
        if (refreshed?.status === "done") return { status: 200, body: { ok: true, deduplicated: true } };
      }
      await db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=?")
        .run(JSON.stringify(result), command.id);
      await updateStateFromResult(device, command, result);
      await audit(device.user_id, device.id, command.type.toUpperCase(), result.ok === false ? "FAILED" : "SUCCESS");
      return { status: 200, body: { ok: true } };
      });
      return json(req, res, response.status, response.body);
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

const photoCleanupTimer = setInterval(() => {
  void processLocalPhotoCleanupJobs().catch(error => console.error("[Jazz Lost Mode] Photo cleanup worker failed:", error?.name || "error"));
}, 30_000);
photoCleanupTimer.unref();
void processLocalPhotoCleanupJobs().catch(error => console.error("[Jazz Lost Mode] Initial photo cleanup failed:", error?.name || "error"));
