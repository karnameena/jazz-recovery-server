import { hashSecret, verifySecret, validatePassword, randomToken, sha256, createSession, getSession, destroySession, sessionCookie, clearSessionCookie, DUMMY_PASSWORD_HASH } from "./security.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const LOGIN_USER_LIMIT = 8;
const LOGIN_IP_LIMIT = 30;
const LOGIN_WINDOW_MINUTES = 15;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
function numericId() {
  const bytes = crypto.getRandomValues(new Uint8Array(7));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return Number(value & ((1n << 52n) - 1n)) + 1;
}
async function readBody(request, maxBytes = 32768) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  try { return raw ? JSON.parse(raw) : {}; } catch { throw Object.assign(new Error("Invalid JSON request."), { status: 400 }); }
}
function passwordError(value) {
  return validatePassword(value);
}
async function audit(db, userId, deviceId, action, status) {
  await db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,?,?,?)")
    .bind(userId ?? null, deviceId ?? null, action, status).run();
}
async function requireSession(db, request) {
  const session = await getSession(db, request);
  return session;
}
async function rateLimited(db, username, ip) {
  const counts = await db.prepare(`SELECT
    SUM(CASE WHEN username_key=? THEN 1 ELSE 0 END) AS user_count,
    SUM(CASE WHEN ip_key=? THEN 1 ELSE 0 END) AS ip_count
    FROM auth_login_attempts
    WHERE attempted_at > datetime('now', ?) AND succeeded=0`)
    .bind(username.toLowerCase(), ip, `-${LOGIN_WINDOW_MINUTES} minutes`).first();
  return Number(counts?.user_count || 0) >= LOGIN_USER_LIMIT || Number(counts?.ip_count || 0) >= LOGIN_IP_LIMIT;
}
async function recordLogin(db, username, ip, succeeded) {
  await db.prepare("INSERT INTO auth_login_attempts(username_key,ip_key,succeeded) VALUES(?,?,?)")
    .bind(username.toLowerCase(), ip, succeeded ? 1 : 0).run();
  await db.prepare("DELETE FROM auth_login_attempts WHERE attempted_at < datetime('now','-2 days')").run();
}
async function billingAccess(db, userId) {
  const [trial, subscription, admin] = await Promise.all([
    db.prepare("SELECT starts_at,expires_at FROM billing_trials WHERE user_id=?").bind(userId).first(),
    db.prepare(`SELECT id,status,starts_at,expires_at,amount_paid_paise,plan_type
      FROM billing_subscriptions WHERE user_id=? AND status IN ('active','complimentary')
      AND starts_at<=CURRENT_TIMESTAMP AND expires_at>CURRENT_TIMESTAMP
      ORDER BY expires_at DESC LIMIT 1`).bind(userId).first(),
    db.prepare("SELECT 1 AS yes FROM billing_admins WHERE user_id=?").bind(userId).first(),
  ]);
  const now = Date.now();
  const toMs = value => Date.parse(String(value || "").replace(" ","T") + "Z");
  const isBillingAdmin = Boolean(admin);
  const subscribed = Boolean(subscription && toMs(subscription.starts_at) <= now && toMs(subscription.expires_at) > now);
  const trialing = Boolean(trial && toMs(trial.starts_at) <= now && toMs(trial.expires_at) > now);
  const trialPending = Boolean(trial && toMs(trial.starts_at) > now);
  return {
    trial, subscription, subscribed, trialing, isBillingAdmin,
    allowed: isBillingAdmin || subscribed || trialing,
    access: isBillingAdmin || subscribed ? "subscribed" : trialing ? "trial" : trialPending ? "trial_pending" : "expired",
  };
}
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}
async function consumeRecoveryRelay(db, row, env) {
  let location = null;
  let photo = null;
  const relays = await db.prepare(`SELECT * FROM recovery_result_relays
    WHERE owner_id=? AND device_id=? AND expires_at>CURRENT_TIMESTAMP
    ORDER BY created_at DESC LIMIT 10`).bind(row.user_id,row.id).all();
  for (const relay of relays.results || []) {
    if (relay.kind === "location" && !location && relay.payload_json) {
      try {
        const value = JSON.parse(relay.payload_json);
        const age = Date.now() - Number(value.timestamp || relay.result_timestamp);
        location = { ...value, status: age <= 90000 ? "live" : age > 86400000 ? "old" : "cached", relayId: relay.id };
      } catch {}
    }
    if (relay.kind === "photo" && !photo && relay.payload_json) {
      try {
        const value = JSON.parse(relay.payload_json);
        if (typeof value.dataUrl === "string" && /^data:image\/(png|jpeg);base64,/.test(value.dataUrl)) {
          photo = { dataUrl: value.dataUrl, camera: value.camera === "rear" ? "rear" : "front", timestamp: relay.result_timestamp, relayId: relay.id };
        }
      } catch {}
    }
  }
  return { location, photo };
}
async function publicDevice(db, row, env, includeRelay = false) {
  const state = await db.prepare("SELECT mode,battery,charging,network,last_seen,location_services_status,location_services_timestamp FROM device_state WHERE device_id=?")
    .bind(row.id).first() || {};
  const lastSeen = state.last_seen || null;
  const lastSeenMs = lastSeen ? Date.parse(String(lastSeen).replace(" ","T") + (String(lastSeen).endsWith("Z") ? "" : "Z")) : 0;
  const online = Boolean(lastSeenMs && Date.now() - lastSeenMs <= 90000);
  const recovered = includeRelay ? await consumeRecoveryRelay(db,row,env) : {location:null,photo:null};
  return {
    id: row.id, deviceId: row.device_id, deviceName: row.device_name, deviceType: row.device_type,
    online, mode: state.mode || "NORMAL_MODE", battery: state.battery ?? null,
    charging: Boolean(state.charging), network: state.network || "UNKNOWN", lastSeen,
    locationServices: online ? (["ON","OFF"].includes(state.location_services_status) ? state.location_services_status : "UNKNOWN") : "OFFLINE",
    locationServicesLastConfirmed: state.location_services_timestamp || null,
    location: recovered.location, photo: recovered.photo,
  };
}


function webAuthnOriginConfig(request, env) {
  const origin = String(request.headers.get("Origin") || "").replace(/\/+$/, "");
  const allowed = new Set(String(env.WEB_ORIGINS || env.WEB_ORIGIN || "")
    .split(",").map(value => value.trim().replace(/\/+$/, "")).filter(Boolean));
  if (!origin || !allowed.has(origin)) {
    throw Object.assign(new Error("Passkeys require a valid, allowed website origin."), { status: 403 });
  }
  const parsed = new URL(origin);
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw Object.assign(new Error("Passkeys require HTTPS outside local development."), { status: 503 });
  }
  return { rpID: parsed.hostname, rpName: "Jazz Recovery", origin };
}
function parseChallengeRecord(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (parsed && typeof parsed.challenge === "string" && typeof parsed.rpID === "string" && typeof parsed.origin === "string") return parsed;
  } catch {}
  return null;
}
function parseTransports(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
function webAuthnCredentialPublicKey(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value || []);
}
async function handlePasskeyRoutes(request, env, path, method) {
  const db = env.DB;
  if (method === "POST" && path === "/api/auth/passkey/register/options") {
    const session = await getSession(db, request);
    if (!session) return json({ ok: false, error: "Authentication required" }, 401);
    const { rpID, rpName, origin } = webAuthnOriginConfig(request, env);
    const user = await db.prepare("SELECT id,username FROM users WHERE id=?").bind(session.user_id).first();
    if (!user) return json({ ok: false, error: "User not found." }, 404);
    const existing = await db.prepare("SELECT credential_id,transports FROM webauthn_credentials WHERE user_id=?").bind(session.user_id).all();
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.username,
      userID: new TextEncoder().encode(String(user.id)),
      attestationType: "none",
      timeout: 60000,
      excludeCredentials: (existing.results || []).map(item => ({
        id: item.credential_id,
        transports: parseTransports(item.transports),
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    const flowId = crypto.randomUUID();
    const challengeRecord = JSON.stringify({ challenge: options.challenge, rpID, origin });
    await db.prepare("INSERT INTO webauthn_challenges(flow_id,user_id,purpose,challenge,expires_at) VALUES(?,?,'register',?,datetime('now','+5 minutes'))")
      .bind(flowId, session.user_id, challengeRecord).run();
    return json({ ok: true, flowId, options });
  }

  if (method === "POST" && path === "/api/auth/passkey/register/verify") {
    const session = await getSession(db, request);
    if (!session) return json({ ok: false, error: "Authentication required" }, 401);
    const body = await readBody(request, 64 * 1024);
    const flowId = String(body.flowId || "");
    const challengeRow = await db.prepare(`SELECT * FROM webauthn_challenges
      WHERE flow_id=? AND user_id=? AND purpose='register' AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP`)
      .bind(flowId, session.user_id).first();
    const challenge = parseChallengeRecord(challengeRow?.challenge);
    if (!challenge) return json({ ok: false, error: "Passkey registration challenge expired or already used." }, 400);
    const origin = String(request.headers.get("Origin") || "").replace(/\/+$/, "");
    if (origin !== challenge.origin) return json({ ok: false, error: "Passkey origin did not match the registration request." }, 403);
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpID,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) return json({ ok: false, error: "Passkey verification failed." }, 400);
    const info = verification.registrationInfo;
    const credential = info.credential || {
      id: info.credentialID,
      publicKey: info.credentialPublicKey,
      counter: info.counter,
      transports: body.response?.response?.transports || [],
    };
    const consumed = await db.prepare(`UPDATE webauthn_challenges SET consumed_at=CURRENT_TIMESTAMP
      WHERE flow_id=? AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP`).bind(flowId).run();
    if (Number(consumed.meta?.changes || 0) !== 1) return json({ ok: false, error: "Passkey challenge was already used." }, 409);
    try {
      await db.prepare(`INSERT INTO webauthn_credentials
        (credential_id,user_id,public_key,counter,transports,credential_device_type,backed_up)
        VALUES(?,?,?,?,?,?,?)`)
        .bind(credential.id, session.user_id, webAuthnCredentialPublicKey(credential.publicKey),
          Number(credential.counter || 0), JSON.stringify(credential.transports || body.response?.response?.transports || []),
          info.credentialDeviceType || null, info.credentialBackedUp ? 1 : 0).run();
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || ""))) return json({ ok: false, error: "This passkey is already registered." }, 409);
      throw error;
    }
    await audit(db, session.user_id, null, "PASSKEY_REGISTER", "SUCCESS");
    return json({ ok: true, verified: true });
  }

  if (method === "POST" && path === "/api/auth/password-reset/passkey/options") {
    const body = await readBody(request, 16 * 1024);
    const username = String(body.username || "").trim();
    const user = await db.prepare("SELECT id FROM users WHERE lower(username)=lower(?)").bind(username).first();
    const credentials = user
      ? await db.prepare("SELECT credential_id,transports FROM webauthn_credentials WHERE user_id=?").bind(user.id).all()
      : { results: [] };
    if (!user || !(credentials.results || []).length) {
      return json({ ok: true, available: false, message: "No registered passkey is available. Use your recovery PIN instead." });
    }
    const { rpID, origin } = webAuthnOriginConfig(request, env);
    const options = await generateAuthenticationOptions({
      rpID, timeout: 60000, userVerification: "required",
      allowCredentials: (credentials.results || []).map(item => ({
        id: item.credential_id, transports: parseTransports(item.transports),
      })),
    });
    const flowId = crypto.randomUUID();
    const challengeRecord = JSON.stringify({ challenge: options.challenge, rpID, origin });
    await db.prepare(`INSERT INTO webauthn_challenges(flow_id,user_id,username_key,purpose,challenge,expires_at)
      VALUES(?,?,lower(?),'password_reset',?,datetime('now','+5 minutes'))`)
      .bind(flowId, user.id, username, challengeRecord).run();
    return json({ ok: true, available: true, flowId, options });
  }

  if (method === "POST" && path === "/api/auth/password-reset/passkey/verify") {
    const body = await readBody(request, 64 * 1024);
    const flowId = String(body.flowId || "");
    const newPassword = String(body.newPassword || "");
    const passwordProblem = validatePassword(newPassword);
    if (passwordProblem) return json({ ok: false, error: passwordProblem }, 400);
    const challengeRow = await db.prepare(`SELECT * FROM webauthn_challenges
      WHERE flow_id=? AND purpose='password_reset' AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP`)
      .bind(flowId).first();
    const challenge = parseChallengeRecord(challengeRow?.challenge);
    if (!challenge) return json({ ok: false, error: "Passkey challenge expired or already used." }, 400);
    const origin = String(request.headers.get("Origin") || "").replace(/\/+$/, "");
    if (origin !== challenge.origin) return json({ ok: false, error: "Passkey origin did not match the reset request." }, 403);
    const credentialId = String(body.response?.id || "");
    const credential = await db.prepare("SELECT * FROM webauthn_credentials WHERE credential_id=? AND user_id=?")
      .bind(credentialId, challengeRow.user_id).first();
    if (!credential) return json({ ok: false, error: "Passkey verification failed." }, 401);
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpID,
      credential: {
        id: credential.credential_id,
        publicKey: webAuthnCredentialPublicKey(credential.public_key),
        counter: Number(credential.counter || 0),
        transports: parseTransports(credential.transports),
      },
      requireUserVerification: true,
    });
    if (!verification.verified) return json({ ok: false, error: "Passkey verification failed." }, 401);
    const consumed = await db.prepare(`UPDATE webauthn_challenges SET consumed_at=CURRENT_TIMESTAMP
      WHERE flow_id=? AND consumed_at IS NULL AND expires_at>CURRENT_TIMESTAMP`).bind(flowId).run();
    if (Number(consumed.meta?.changes || 0) !== 1) return json({ ok: false, error: "Passkey challenge was already used." }, 409);
    await db.batch([
      db.prepare("UPDATE webauthn_credentials SET counter=?,last_used_at=CURRENT_TIMESTAMP WHERE credential_id=?")
        .bind(Number(verification.authenticationInfo.newCounter || 0), credential.credential_id),
      db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(await hashSecret(newPassword), challengeRow.user_id),
      db.prepare("DELETE FROM sessions WHERE user_id=?").bind(challengeRow.user_id),
    ]);
    await audit(db, challengeRow.user_id, null, "PASSWORD_RESET_PASSKEY", "SUCCESS");
    return json({ ok: true, message: "Password reset successful. All existing sessions have been signed out." }, 200, { "set-cookie": clearSessionCookie() });
  }
  return null;
}

export async function handleAuthAndCoreRoutes(request, env, url) {
  const db = env.DB;
  const path = url.pathname;
  const method = request.method;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const passkeyRoute = await handlePasskeyRoutes(request, env, path, method);
  if (passkeyRoute) return passkeyRoute;

  if (method === "POST" && path === "/api/auth/register") {
    const body = await readBody(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const deviceName = String(body.deviceName || "").trim();
    const imei = String(body.imei || "").replace(/[\s-]/g, "");
    const deviceId = String(body.deviceId || "").trim();
    const deviceToken = String(body.deviceToken || "").trim();
    const pin = String(body.recoveryPin || "");
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) return json({ ok:false,error:"Username must be 3–64 letters, numbers, dots, underscores or hyphens." },400);
    const pError = passwordError(password); if (pError) return json({ok:false,error:pError},400);
    if (!/^\d{4}$/.test(pin) || pin !== String(body.confirmRecoveryPin || "")) return json({ok:false,error:"Enter and confirm the same 4-digit recovery PIN."},400);
    if (!deviceName || deviceName.length > 80) return json({ok:false,error:"Enter a device name (up to 80 characters)."},400);
    if (!/^\d{14,16}$/.test(imei)) return json({ok:false,error:"Enter a valid 14–16 digit IMEI."},400);
    if (!/^[A-Za-z0-9._:-]{3,120}$/.test(deviceId)) return json({ok:false,error:"Invalid device token ID."},400);
    if (deviceToken.length < 32 || deviceToken.length > 512 || !/^[A-Za-z0-9_-]+$/.test(deviceToken)) return json({ok:false,error:"Generate a valid device token in the Jazz Recovery app."},400);

    const duplicate = await db.prepare("SELECT 1 AS found FROM users WHERE lower(username)=lower(?)").bind(username).first();
    if (duplicate) return json({ok:false,error:"Username is already registered."},409);
    const duplicateDevice = await db.prepare("SELECT 1 AS found FROM devices WHERE device_id=?").bind(deviceId).first();
    if (duplicateDevice) return json({ok:false,error:"This device token ID is already registered."},409);

    const userId = numericId();
    const deviceDbId = numericId();
    const trialDays = Math.max(0, Math.min(365, Number(env.TRIAL_DAYS ?? 7)));
    const sqliteTimestamp = value => value.toISOString().slice(0, 19).replace("T", " ");
    const startsAt = sqliteTimestamp(new Date());
    const expiresAt = sqliteTimestamp(new Date(Date.now() + trialDays * 86400000));
    const claimPepper = String(env.TRIAL_CLAIM_PEPPER || "");
    if (trialDays > 0 && !claimPepper) return json({ok:false,error:"Registration is temporarily unavailable: trial security configuration is missing."},503);
    const claimHash = trialDays > 0 ? await hmacSha256(claimPepper, username.toLowerCase()) : null;

    let results;
    try {
      const statements = [
        db.prepare("INSERT INTO users(id,username,password_hash,recovery_pin_hash,recovery_pin_updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)")
          .bind(userId, username, await hashSecret(password), await hashSecret(pin)),
        db.prepare("INSERT INTO devices(id,user_id,device_id,device_name,device_type,credential_hash,imei) VALUES(?,?,?,?,?,?,?)")
          .bind(deviceDbId, userId, deviceId, deviceName, "Android", await sha256(deviceToken), imei),
        db.prepare("INSERT INTO device_state(device_id) VALUES(?)").bind(deviceDbId),
      ];
      if (trialDays > 0) {
        statements.push(db.prepare("INSERT OR IGNORE INTO billing_trial_claims(username_hash,user_id) VALUES(?,?)").bind(claimHash,userId));
        statements.push(db.prepare("INSERT INTO billing_trials(user_id,starts_at,expires_at) VALUES(?,?,?)").bind(userId,startsAt,expiresAt));
      }
      results = await db.batch(statements);
    } catch (error) {
      await db.prepare("DELETE FROM users WHERE id=?").bind(userId).run().catch(()=>{});
      if (/UNIQUE|constraint/i.test(String(error?.message || ""))) return json({ok:false,error:"Username or device is already registered."},409);
      throw error;
    }
    if (trialDays > 0 && Number(results[3]?.meta?.changes || 0) !== 1) {
      await db.prepare("DELETE FROM users WHERE id=?").bind(userId).run();
      return json({ok:false,error:"This username has already claimed a trial. Contact support if the previous account was deleted by an administrator."},409);
    }
    await audit(db,userId,deviceDbId,"DEVICE_REGISTER","SUCCESS").catch(()=>{});
    if (trialDays > 0) await audit(db,userId,null,"TRIAL_ACTIVATED","SUCCESS").catch(()=>{});
    return json({
      ok:true,username,trialActivated:trialDays>0,trialDays,
      trial:trialDays>0?{startsAt,expiresAt}:null,
      device:{id:deviceDbId,deviceId,deviceName,imei,deviceType:"Android"},
    },201);
  }

  if (method === "POST" && path === "/api/auth/login") {
    const body = await readBody(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || username.length > 64 || !password || password.length > 512) return json({ok:false,error:"Invalid username or password"},401);
    if (await rateLimited(db,username,ip)) return json({ok:false,error:"Too many login attempts. Try again later."},429,{"retry-after":"900"});
    const user = await db.prepare("SELECT * FROM users WHERE lower(username)=lower(?)").bind(username).first();
    const valid = await verifySecret(password,user?.password_hash || DUMMY_PASSWORD_HASH);
    if (!user || !valid) {
      await recordLogin(db,username,ip,false);
      await audit(db,user?.id??null,null,"LOGIN","FAILED");
      return json({ok:false,error:"Invalid username or password"},401);
    }
    await recordLogin(db,username,ip,true);
    const session = await createSession(db,user.id);
    await audit(db,user.id,null,"LOGIN","SUCCESS");
    return json({ok:true,username:user.username,expiresAt:session.expiresAt},200,{"set-cookie":sessionCookie(session.token,session.expiresAt)});
  }

  if (method === "POST" && path === "/api/auth/logout") {
    const session = await getSession(db,request);
    if (session) await audit(db,session.user_id,null,"LOGOUT","SUCCESS");
    await destroySession(db,request);
    return json({ok:true},200,{"set-cookie":clearSessionCookie()});
  }

  if (method === "GET" && path === "/api/auth/session") {
    const session = await requireSession(db,request);
    if (!session) return json({ok:false,error:"Authentication required"},401);
    return json({ok:true,username:session.username,expiresAt:session.expires_at});
  }

  if (method === "POST" && path === "/api/auth/recovery-pin") {
    const session = await requireSession(db,request);
    if (!session) return json({ok:false,error:"Authentication required"},401);
    const body = await readBody(request,16384);
    const currentPassword = String(body.currentPassword || "");
    const pin = String(body.recoveryPin || "");
    if (!currentPassword || currentPassword.length > 512) return json({ok:false,error:"Enter your current password."},400);
    if (!/^\d{4}$/.test(pin) || pin !== String(body.confirmRecoveryPin || "")) return json({ok:false,error:"Enter and confirm the same 4-digit recovery PIN."},400);
    const user = await db.prepare("SELECT password_hash FROM users WHERE id=?").bind(session.user_id).first();
    if (!user || !(await verifySecret(currentPassword,user.password_hash))) return json({ok:false,error:"Current password is incorrect."},401);
    await db.prepare("UPDATE users SET recovery_pin_hash=?,recovery_pin_updated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(await hashSecret(pin),session.user_id).run();
    await audit(db,session.user_id,null,"RECOVERY_PIN_UPDATED","SUCCESS");
    return json({ok:true,message:"Recovery PIN updated."});
  }

  if (method === "POST" && path === "/api/auth/device-repair") {
    const body = await readBody(request);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const deviceId = String(body.deviceId || "").trim();
    const deviceToken = String(body.deviceToken || "").trim();
    const deviceName = String(body.deviceName || "").trim();
    const imei = String(body.imei || "").replace(/[\s-]/g,"");
    if (!username || username.length>64 || !password || password.length>512 ||
        !/^[A-Za-z0-9._:-]{8,128}$/.test(deviceId) ||
        deviceToken.length<32 || deviceToken.length>512 || !/^[A-Za-z0-9_-]+$/.test(deviceToken)) {
      return json({ok:false,error:"Username, password, existing device ID and a new device token are required."},400);
    }
    if (deviceName.length>80 || (imei && !/^\d{14,16}$/.test(imei))) return json({ok:false,error:"Device name or IMEI is invalid."},400);
    if (await rateLimited(db,username,ip)) return json({ok:false,error:"Too many attempts. Try again later."},429,{"retry-after":"900"});
    const user = await db.prepare("SELECT * FROM users WHERE lower(username)=lower(?)").bind(username).first();
    if (!(await verifySecret(password,user?.password_hash || DUMMY_PASSWORD_HASH)) || !user) {
      await recordLogin(db,username,ip,false);
      await audit(db,user?.id??null,null,"DEVICE_REPAIR","FAILED_AUTH");
      return json({ok:false,error:"Invalid username or password."},401);
    }
    const device = await db.prepare("SELECT id FROM devices WHERE user_id=? AND device_id=?").bind(user.id,deviceId).first();
    if (!device) {
      await audit(db,user.id,null,"DEVICE_REPAIR","DEVICE_NOT_OWNED");
      return json({ok:false,error:"That existing device ID is not registered to this account. Check the ID from your original pairing details."},404);
    }
    await db.prepare(`UPDATE devices SET credential_hash=?,device_name=COALESCE(NULLIF(?,''),device_name),
      imei=COALESCE(NULLIF(?,''),imei),updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`)
      .bind(await sha256(deviceToken),deviceName,imei,device.id,user.id).run();
    await audit(db,user.id,device.id,"DEVICE_REPAIR","SUCCESS");
    await recordLogin(db,username,ip,true);
    return json({ok:true,deviceId,message:"Existing device record re-paired. Its history and recovery state were preserved."});
  }

  if (method === "POST" && path === "/api/auth/forgot-password") {
    const body = await readBody(request,16384);
    const username = String(body.username || "").trim();
    const pin = String(body.recoveryPin || "");
    const newPassword = String(body.newPassword || "");
    const passwordProblem = passwordError(newPassword);
    if (passwordProblem) return json({ok:false,error:passwordProblem},400);
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username) || !/^\d{4}$/.test(pin)) return json({ok:false,error:"Invalid username or recovery PIN."},400);
    const attempts = await db.prepare(`SELECT COUNT(*) AS total FROM auth_recovery_attempts
      WHERE username_key=? AND ip_key=? AND attempted_at > datetime('now','-15 minutes') AND succeeded=0`)
      .bind(username.toLowerCase(),ip).first();
    if (Number(attempts?.total||0)>=5) return json({ok:false,error:"Too many recovery attempts. Try again in 15 minutes."},429,{"retry-after":"900"});
    const user = await db.prepare("SELECT id,recovery_pin_hash FROM users WHERE lower(username)=lower(?)").bind(username).first();
    const valid = await verifySecret(pin,user?.recovery_pin_hash||DUMMY_PASSWORD_HASH);
    if (!user || !user.recovery_pin_hash || !valid) {
      await db.prepare("INSERT INTO auth_recovery_attempts(username_key,ip_key,succeeded) VALUES(?,?,0)").bind(username.toLowerCase(),ip).run();
      await audit(db,user?.id??null,null,"PASSWORD_RESET_PIN","FAILED");
      return json({ok:false,error:"Invalid username or recovery PIN."},401);
    }
    const statements = [
      db.prepare("UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(await hashSecret(newPassword),user.id),
      db.prepare("DELETE FROM sessions WHERE user_id=?").bind(user.id),
      db.prepare("INSERT INTO auth_recovery_attempts(username_key,ip_key,succeeded) VALUES(?,?,1)").bind(username.toLowerCase(),ip),
      db.prepare("INSERT INTO recovery_audit(user_id,action,status) VALUES(?,'PASSWORD_RESET_PIN','SUCCESS')").bind(user.id),
    ];
    await db.batch(statements);
    return json({ok:true,message:"Password reset successful. All existing sessions have been signed out."},200,{"set-cookie":clearSessionCookie()});
  }

  if (method === "GET" && path === "/api/billing/status") {
    const session = await requireSession(db,request);
    if (!session) return json({ok:false,error:"Authentication required"},401);
    const access = await billingAccess(db,session.user_id);
    const [latestSubscription,pending] = await Promise.all([
      db.prepare("SELECT id,status,starts_at,expires_at,amount_paid_paise,plan_type FROM billing_subscriptions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1").bind(session.user_id).first(),
      db.prepare("SELECT id,plan_type,amount_paise,status,created_at FROM billing_payment_intents WHERE user_id=? AND status IN ('pending','awaiting_dynamic_checkout') ORDER BY created_at DESC LIMIT 1").bind(session.user_id).first(),
    ]);
    return json({
      ok:true,trial:access.trial?{startsAt:access.trial.starts_at,expiresAt:access.trial.expires_at,active:access.trialing}:null,
      subscription:latestSubscription?{...latestSubscription,active:Boolean(access.subscription&&latestSubscription.id===access.subscription.id)}:null,
      pendingPayment:pending||null,access:access.access,canUsePaidFeatures:access.allowed,isBillingAdmin:access.isBillingAdmin,
    });
  }

  if (method === "GET" && path === "/api/devices") {
    const session = await requireSession(db,request);
    if (!session) return json({ok:false,error:"Authentication required"},401);
    const rows = await db.prepare("SELECT * FROM devices WHERE user_id=? ORDER BY device_name").bind(session.user_id).all();
    const items = await Promise.all((rows.results||[]).map(row=>publicDevice(db,row,env,false)));
    return json({ok:true,items});
  }

  const deviceMatch = path.match(/^\/api\/devices\/(\d+)$/);
  if (method === "GET" && deviceMatch) {
    const session = await requireSession(db,request);
    if (!session) return json({ok:false,error:"Authentication required"},401);
    const row = await db.prepare("SELECT * FROM devices WHERE id=? AND user_id=?").bind(Number(deviceMatch[1]),session.user_id).first();
    if (!row) return json({ok:false,error:"Device not found"},404);
    return json({ok:true,device:await publicDevice(db,row,env,true)});
  }

  const imeiMatch = path.match(/^\/api\/devices\/(\d+)\/imei$/);
  if (method === "GET" && imeiMatch) {
    const session = await requireSession(db,request);
    if (!session) return json({ok:false,error:"Authentication required"},401);
    const row = await db.prepare("SELECT imei FROM devices WHERE id=? AND user_id=?").bind(Number(imeiMatch[1]),session.user_id).first();
    if (!row) return json({ok:false,error:"Device not found"},404);
    return json({ok:true,imei:row.imei||null});
  }

  return null;
}
async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature = await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
