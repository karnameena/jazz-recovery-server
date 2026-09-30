import http from "node:http";
import crypto from "node:crypto";
import { applyMigrations, db } from "./db/database.mjs";
import { verifySecret } from "./auth/password.mjs";
import { createSession, sessionCookie, clearSessionCookie, getSession, destroySession } from "./auth/sessions.mjs";

applyMigrations();

const port = Number(process.env.PORT || 8890);
const publicOrigin = String(process.env.LOST_MODE_PUBLIC_ORIGIN || "http://localhost:5190").replace(/\/$/, "");
const ONLINE_WINDOW_MS = 90_000;
const MAX_VOICE_WAV_BYTES = 900_000;
const ALLOWED_COMMANDS = new Set(["DEVICE_STATUS", "GET_LOCATION", "RING_DEVICE", "RECOVERY_PHOTO", "SET_RECOVERY_MODE", "PLAY_VOICE_MESSAGE"]);
const loginAttempts = new Map();

function json(res, status, body, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  for (const [name, value] of Object.entries(extraHeaders)) res.setHeader(name, value);
  res.end(JSON.stringify(body));
}

function readJson(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

function ipOf(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function rateLimited(key) {
  const now = Date.now();
  const list = (loginAttempts.get(key) || []).filter(ts => now - ts < 10 * 60_000);
  if (list.length >= 8) return true;
  list.push(now);
  loginAttempts.set(key, list);
  return false;
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
    json(res, 401, { ok: false, error: "Authentication required" });
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
  if (!deviceId || !token) return null;
  const row = db.prepare("SELECT * FROM devices WHERE device_id=?").get(deviceId);
  if (!row || !verifySecret(token, row.credential_hash)) return null;
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
  if (command.type === "recovery_photo" && result.ok && result.imageBase64) {
    const mime = result.mimeType || "image/jpeg";
    const dataUrl = `data:${mime};base64,${result.imageBase64}`;
    db.prepare("UPDATE device_state SET photo_data_url=?,photo_camera=?,photo_timestamp=?,last_seen=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE device_id=?")
      .run(dataUrl, result.camera || "front", result.timestamp || Date.now(), device.id);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (req.headers.origin && req.headers.origin === publicOrigin) {
    res.setHeader("Access-Control-Allow-Origin", publicOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Jazz-Lost-Device-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.statusCode = 204;
    return res.end();
  }

  try {
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, service: "jazz-lost-mode-server", storage: "sqlite" });

    if (req.method === "POST" && path === "/api/auth/login") {
      const body = await readJson(req);
      const username = String(body.username || "").trim();
      const key = `${ipOf(req)}:${username.toLowerCase()}`;
      if (rateLimited(key)) return json(res, 429, { ok: false, error: "Too many login attempts. Try again later." });
      const user = db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(username);
      if (!user || !verifySecret(body.password, user.password_hash)) {
        audit(user?.id ?? null, null, "LOGIN", "FAILED");
        return json(res, 401, { ok: false, error: "Invalid username or password" });
      }
      const session = createSession(user.id);
      audit(user.id, null, "LOGIN", "SUCCESS");
      return json(res, 200, { ok: true, username: user.username, expiresAt: session.expires }, { "Set-Cookie": sessionCookie(session.token, session.expires) });
    }

    if (req.method === "POST" && path === "/api/auth/logout") {
      const session = getSession(req);
      if (session) audit(session.user_id, null, "LOGOUT", "SUCCESS");
      destroySession(req);
      return json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
    }

    if (req.method === "GET" && path === "/api/auth/session") {
      const session = requireSession(req, res);
      if (!session) return;
      return json(res, 200, { ok: true, username: session.username, expiresAt: session.expires_at });
    }

    if (req.method === "GET" && path === "/api/devices") {
      const session = requireSession(req, res); if (!session) return;
      const rows = db.prepare("SELECT * FROM devices WHERE user_id=? ORDER BY device_name").all(session.user_id);
      return json(res, 200, { ok: true, items: rows.map(publicDevice) });
    }

    const deviceMatch = path.match(/^\/api\/devices\/(\d+)$/);
    if (req.method === "GET" && deviceMatch) {
      const session = requireSession(req, res); if (!session) return;
      const row = ownerDevice(session.user_id, deviceMatch[1]);
      if (!row) return json(res, 404, { ok: false, error: "Device not found" });
      return json(res, 200, { ok: true, device: publicDevice(row) });
    }

    const actionMatch = path.match(/^\/api\/devices\/(\d+)\/actions$/);
    if (req.method === "POST" && actionMatch) {
      const session = requireSession(req, res); if (!session) return;
      const row = ownerDevice(session.user_id, actionMatch[1]);
      if (!row) return json(res, 404, { ok: false, error: "Device not found" });
      const body = await readJson(req);
      const action = String(body.action || "").toUpperCase();
      if (!ALLOWED_COMMANDS.has(action)) return json(res, 400, { ok: false, error: "Recovery action is not allowed" });
      const mapped = mapCommand(action, body.args || {});
      if (!mapped) return json(res, 400, { ok: false, error: action === "PLAY_VOICE_MESSAGE" ? "Invalid or oversized recovery voice message" : "Invalid recovery action arguments" });
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO recovery_commands(id,device_id,type,args_json) VALUES(?,?,?,?)")
        .run(id, row.id, mapped.type, JSON.stringify(mapped.args));
      audit(session.user_id, row.id, action, "QUEUED");
      return json(res, 202, { ok: true, commandId: id, status: "QUEUED" });
    }

    const auditMatch = path.match(/^\/api\/devices\/(\d+)\/audit$/);
    if (req.method === "GET" && auditMatch) {
      const session = requireSession(req, res); if (!session) return;
      const row = ownerDevice(session.user_id, auditMatch[1]);
      if (!row) return json(res, 404, { ok: false, error: "Device not found" });
      const items = db.prepare("SELECT action,status,created_at FROM recovery_audit WHERE user_id=? AND device_id=? ORDER BY id DESC LIMIT 50").all(session.user_id, row.id)
        .map(item => ({ ...item, created_at: sqliteUtcToIso(item.created_at) }));
      return json(res, 200, { ok: true, items });
    }

    if (req.method === "POST" && path === "/android/device/heartbeat") {
      const device = authenticateDevice(req);
      if (!device) return json(res, 401, { ok: false, error: "Unauthorized device" });
      const body = await readJson(req);
      if (body.deviceId && body.deviceId !== device.device_id) return json(res, 403, { ok: false, error: "Device identity mismatch" });
      updateStateFromHeartbeat(device, body);
      return json(res, 200, { ok: true, serverTime: Date.now() });
    }

    if (req.method === "GET" && path === "/android/device/commands/next") {
      const device = authenticateDevice(req);
      if (!device) return json(res, 401, { ok: false, error: "Unauthorized device" });
      const command = db.prepare(`SELECT * FROM recovery_commands WHERE device_id=? AND status='pending' AND (leased_until IS NULL OR leased_until<CURRENT_TIMESTAMP) ORDER BY created_at LIMIT 1`).get(device.id);
      if (!command) return json(res, 200, { ok: true, command: null });
      const leasedUntil = sqliteUtcTimestamp(Date.now() + 30_000);
      db.prepare("UPDATE recovery_commands SET leased_until=? WHERE id=?").run(leasedUntil, command.id);
      return json(res, 200, { ok: true, command: { id: command.id, type: command.type, args: JSON.parse(command.args_json || "{}"), createdAt: sqliteUtcToIso(command.created_at) } });
    }

    const resultMatch = path.match(/^\/android\/device\/commands\/([a-f0-9-]+)\/result$/i);
    if (req.method === "POST" && resultMatch) {
      const device = authenticateDevice(req);
      if (!device) return json(res, 401, { ok: false, error: "Unauthorized device" });
      const command = db.prepare("SELECT * FROM recovery_commands WHERE id=? AND device_id=?").get(resultMatch[1], device.id);
      if (!command) return json(res, 404, { ok: false, error: "Unknown recovery command" });
      const body = await readJson(req, 8 * 1024 * 1024);
      const result = body.result || {};
      db.prepare("UPDATE recovery_commands SET status='done',result_json=?,completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE id=?")
        .run(JSON.stringify(result), command.id);
      updateStateFromResult(device, command, result);
      audit(device.user_id, device.id, command.type.toUpperCase(), result.ok === false ? "FAILED" : "SUCCESS");
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error(`[Jazz Lost Mode] ${req.method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return json(res, 500, { ok: false, error: "Lost Mode server error" });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[Jazz Lost Mode] listening on :${port}`);
  console.log("[Jazz Lost Mode] SQLite persistence active; existing Jazz services are independent.");
});
