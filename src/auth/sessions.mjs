import crypto from "node:crypto";
import { db, cleanupExpiredSessions } from "../db/database.mjs";
import { randomToken, tokenHash } from "./password.mjs";

const COOKIE_NAME = "jazz_lost_mode_session";
const ttlMinutes = Math.max(5, Number(process.env.LOST_MODE_SESSION_TTL_MINUTES || 30));
const secure = String(process.env.LOST_MODE_COOKIE_SECURE || "false").toLowerCase() === "true";

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
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
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Expires=${new Date(expires).toUTCString()}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

export function getSession(req) {
  cleanupExpiredSessions();
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`SELECT s.id session_id,s.user_id,u.username,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP`)
    .get(tokenHash(token));
  if (!row) return null;
  db.prepare("UPDATE sessions SET last_used_at=CURRENT_TIMESTAMP WHERE id=?").run(row.session_id);
  return row;
}

export function destroySession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash(token));
}
