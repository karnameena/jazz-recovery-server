import assert from "node:assert/strict";
import { sendFcmWake } from "../src/fcm.js";

const generated = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generated.privateKey));
let binary = "";
for (const byte of pkcs8) binary += String.fromCharCode(byte);
const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----`;

const env = {
  FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
    type: "service_account",
    project_id: "karnaappsgk",
    client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
    private_key: pem,
  }),
};
let fcmStatus = 200;
let sentMessage = null;
let deletedToken = false;
const db = {
  prepare(sql) {
    return {
      bind(...values) {
        return {
          async first() {
            assert.match(sql, /SELECT fcm_token/);
            return { fcm_token: "test-fcm-registration-token-1234567890" };
          },
          async run() {
            assert.match(sql, /DELETE FROM device_push_tokens/);
            assert.equal(values[0], 7);
            deletedToken = true;
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target === "https://oauth2.googleapis.com/token") {
    assert.equal(options.method, "POST");
    assert.match(String(options.body), /jwt-bearer/);
    return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  assert.match(target, /fcm\.googleapis\.com\/v1\/projects\/karnaappsgk\/messages:send$/);
  assert.equal(options.headers.authorization, "Bearer test-access-token");
  sentMessage = JSON.parse(options.body);
  if (fcmStatus === 200) {
    return new Response(JSON.stringify({ name: "projects/karnaappsgk/messages/123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({
    error: { details: [{ errorCode: "UNREGISTERED" }] },
  }), { status: fcmStatus, headers: { "content-type": "application/json" } });
};

try {
  const sent = await sendFcmWake(env, db, { id: 7 }, "command-123");
  assert.equal(sent.status, "SENT");
  assert.equal(sentMessage.message.data.event, "command_wakeup");
  assert.equal(sentMessage.message.data.commandId, "command-123");
  assert.equal(sentMessage.message.android.priority, "HIGH");
  assert.equal(sentMessage.message.android.ttl, "60s");
  assert.equal("notification" in sentMessage.message, false);

  fcmStatus = 404;
  const stale = await sendFcmWake(env, db, { id: 7 }, "command-456");
  assert.equal(stale.status, "NOT_REGISTERED");
  assert.equal(deletedToken, true);
} finally {
  globalThis.fetch = originalFetch;
}

process.stdout.write("FCM sender tests passed.\n");
