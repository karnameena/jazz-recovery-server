import crypto from "node:crypto";

const KEY_LEN = 64;
const N = 1 << 15;
const r = 8;
const p = 1;

export function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) return "Password must include upper-case, lower-case and a number.";
  return null;
}

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, KEY_LEN, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifySecret(secret, encoded) {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = String(encoded || "").split("$");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hashRaw, "base64url");
    const actual = crypto.scryptSync(String(secret), Buffer.from(saltRaw, "base64url"), expected.length, {
      N: Number(nRaw), r: Number(rRaw), p: Number(pRaw), maxmem: 64 * 1024 * 1024
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

export function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString("base64url"); }
export function tokenHash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
