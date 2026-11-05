import crypto from "node:crypto";
import { db, cleanupExpiredSessions } from "../db/database.mjs";
import { randomToken, tokenHash } from "./password.mjs";

const LEGACY_COOKIE_NAME = "jazz_lost_mode_session";
const isProduction = String(process.env.NODE_ENV || "").toLowerCase() === "production" || String(process.env.RENDER || "").toLowerCase() === "true";
const secure = process.env.LOST_MODE_COOKIE_SECURE == null
  ? isProduction
  : String(process.env.LOST_MODE_COOKIE_SECURE).toLowerCase() === "true";
const COOKIE_NAME = secure ? "__Host-jazz_lost_mode_session" : LEGACY_COOKIE_NAME;
const ttlMinutes = Math.min(120, Math.max(5, Number(process.env.LOST_MODE_SESSION_TTL_MINUTES || 30)));
const configuredSameSite = String(process.env.LOST_MODE_COOKIE_SAMESITE || (secure ? "None" : "Strict")).trim().toLowerCase();
const sameSite = configuredSameSite === "none" && secure
  ? "None"
  : configuredSameSite === "lax"
    ? "Lax"
    : "Strict";

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      // Ignore malformed cookie values instead of turning an auth check into a 500.
    }
  }
  return out;
}

function incomingSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies[COOKIE_NAME] || cookies[LEGACY_COOKIE_NAME] || "";
}

export function createSession(userId) {
  cleanupExpiredSessions();
  const token = randomToken(32);
  const id = crypto.randomUUID();
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)")
    .run(id, userId, tokenHash(token), expires);
  return { token, expires };
}

export function sessionCookie(token, expires) {
  const maxAge = Math.max(0, Math.floor((new Date(expires).getTime() - Date.now()) / 1000));
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}; Expires=${new Date(expires).toUTCString()}; Priority=High${secure ? "; Secure" : ""}`;
}

export function clearSessionCookies() {
  const flags = `Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? "; Secure" : ""}`;
  const cookies = [`${COOKIE_NAME}=; ${flags}`];
  if (COOKIE_NAME !== LEGACY_COOKIE_NAME) {
    cookies.push(`${LEGACY_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  }
  return cookies;
}

export function clearSessionCookie() {
  return clearSessionCookies()[0];
}

export function getSession(req) {
  cleanupExpiredSessions();
  const token = incomingSessionToken(req);
  if (!token) return null;
  const row = db.prepare(`SELECT s.id session_id,s.user_id,u.username,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND julianday(s.expires_at)>julianday('now')`)
    .get(tokenHash(token));
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_used_at=CURRENT_TIMESTAMP WHERE id=?").run(row.session_id);
  return row;
}

export function destroySession(req) {
  const token = incomingSessionToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
}
