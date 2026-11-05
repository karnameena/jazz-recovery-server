const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 256;
const DUMMY_PASSWORD_HASH = "pbkdf2-sha256$100000$AQIDBAUGBwgJCgsMDQ4PEA$xVTcIf1Zzi7uLLPfhDalCO6JCt_uibLY2_nBYjl6muw";
export { DUMMY_PASSWORD_HASH };

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return toBase64Url(data);
}
export async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function derivePbkdf2(secret, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(secret)),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_LENGTH,
  );
  return new Uint8Array(bits);
}
export async function hashSecret(secret) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derivePbkdf2(secret, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(bits)}`;
}
export async function verifySecret(secret, encoded) {
  try {
    const [scheme, iterationsRaw, saltRaw, expectedRaw] = String(encoded || "").split("$");
    const iterations = Number(iterationsRaw);
    if (scheme !== "pbkdf2-sha256" || iterations !== PBKDF2_ITERATIONS) return false;
    const salt = fromBase64Url(saltRaw);
    const expected = fromBase64Url(expectedRaw);
    if (salt.length !== 16 || expected.length !== KEY_LENGTH / 8) return false;
    const actual = await derivePbkdf2(secret, salt, iterations);
    let mismatch = 0;
    for (let i = 0; i < expected.length; i += 1) mismatch |= expected[i] ^ actual[i];
    return mismatch === 0;
  } catch {
    return false;
  }
}
export function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) return "Password must include upper-case, lower-case and a number.";
  return null;
}
export function parseCookies(request) {
  const out = {};
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    try { out[name] = decodeURIComponent(part.slice(index + 1).trim()); } catch {}
  }
  return out;
}
export const COOKIE_NAME = "__Host-jazz_lost_mode_session";
function parseSqliteUtc(value) {
  const raw = String(value || "");
  return Date.parse(raw.includes("T") ? raw : `${raw.replace(" ","T")}Z`);
}
export function sessionCookie(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((parseSqliteUtc(expiresAt) - Date.now()) / 1000));
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}; Expires=${new Date(expiresAt).toUTCString()}; Priority=High`;
}
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Priority=High`;
}
export async function createSession(db, userId) {
  const token = randomToken(32);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(0,19).replace("T"," ");
  await db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
  await db.prepare("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES(?,?,?,?)")
    .bind(id, userId, await sha256(token), expiresAt).run();
  return { token, expiresAt };
}
export async function getSession(db, request) {
  const token = parseCookies(request)[COOKIE_NAME] || "";
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await db.prepare(`SELECT s.id AS session_id,s.user_id,u.username,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>CURRENT_TIMESTAMP`).bind(tokenHash).first();
  if (!row) return null;
  await db.prepare("UPDATE sessions SET last_used_at=CURRENT_TIMESTAMP WHERE id=? AND last_used_at < datetime('now','-5 minutes')").bind(row.session_id).run();
  return row;
}
export async function destroySession(db, request) {
  const token = parseCookies(request)[COOKIE_NAME] || "";
  if (token) await db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
}
