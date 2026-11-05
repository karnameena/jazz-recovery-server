import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { DUMMY_PASSWORD_HASH, hashSecret, verifySecret } from "../src/security.js";

const encoder = new TextEncoder();
function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function makeHash(password, iterations) {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const key = await webcrypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = new Uint8Array(await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256
  ));
  return `pbkdf2-sha256$${iterations}$${base64Url(salt)}$${base64Url(bits)}`;
}

const knownPassword = "JazzFreshPassword123";
const compatibleHash = await makeHash(knownPassword, 100000);
assert.equal(await verifySecret(knownPassword, compatibleHash), true,
  "must verify PBKDF2-SHA-256 hashes at exactly 100,000 iterations");
assert.equal(await verifySecret("WrongPassword123", compatibleHash), false,
  "must reject an incorrect password");

const newlyEncoded = await hashSecret("NewJazzPassword123");
assert.match(newlyEncoded, /^pbkdf2-sha256\$100000\$/,
  "new hashes must use exactly 100,000 iterations");
assert.equal(await verifySecret("NewJazzPassword123", newlyEncoded), true,
  "newly generated hashes must verify");
assert.equal(await verifySecret("WrongPassword123", newlyEncoded), false,
  "new hashes must reject an incorrect password");

assert.match(DUMMY_PASSWORD_HASH, /^pbkdf2-sha256\$100000\$/,
  "dummy hash must use the same supported work factor");
assert.equal(await verifySecret("JazzRecoveryDummyPasswordNotARealAccount!", DUMMY_PASSWORD_HASH), true,
  "dummy hash must be a valid PBKDF2 hash for timing equalization");
assert.equal(await verifySecret("anything", await makeHash("anything", 100001)), false,
  "must reject iteration counts above Cloudflare's supported ceiling before deriving");
assert.equal(await verifySecret("anything", await makeHash("anything", 120000)), false,
  "fresh-account deployment must reject the obsolete 120,000-iteration format");

console.log("PASS: Cloudflare Web Crypto PBKDF2-SHA-256 at 100,000 iterations; wrong passwords, dummy hash, and unsupported iteration counts checked");
