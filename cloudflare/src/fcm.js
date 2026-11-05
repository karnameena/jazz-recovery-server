let cachedAccessToken = "";
let cachedAccessTokenExpiresAt = 0;
let cachedServiceAccount = "";

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeJson(value) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToBytes(pem) {
  const body = String(pem || "")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new Error("Invalid service-account private key");
  }
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const accountKey = `${serviceAccount.client_email}:${serviceAccount.project_id}`;
  if (
    cachedAccessToken &&
    cachedServiceAccount === accountKey &&
    cachedAccessTokenExpiresAt > now + 60
  ) {
    return cachedAccessToken;
  }

  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const claims = encodeJson({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error("Google OAuth token exchange failed");
  }

  cachedAccessToken = String(payload.access_token);
  cachedAccessTokenExpiresAt = now + Math.max(60, Number(payload.expires_in) || 3600);
  cachedServiceAccount = accountKey;
  return cachedAccessToken;
}

/**
 * Sends a silent, high-priority data message. This is a wake-up hint only;
 * the Android app must fetch its authenticated command and acknowledge it.
 * No private key or provider response is returned to the browser or logged.
 */
export async function sendFcmWake(env, db, device, commandId) {
  const rawCredentials = env.FCM_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) return { status: "NOT_CONFIGURED" };

  let serviceAccount;
  try {
    serviceAccount =
      typeof rawCredentials === "string" ? JSON.parse(rawCredentials) : rawCredentials;
  } catch {
    return { status: "FAILED", reason: "INVALID_CONFIGURATION" };
  }

  const projectId = String(serviceAccount?.project_id || "").trim();
  const clientEmail = String(serviceAccount?.client_email || "").trim();
  const privateKey = String(serviceAccount?.private_key || "").replace(/\\n/g, "\n");
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ||
    !clientEmail.includes("@") ||
    !privateKey.includes("BEGIN PRIVATE KEY")
  ) {
    return { status: "FAILED", reason: "INVALID_CONFIGURATION" };
  }

  try {
    const tokenRow = await db
      .prepare("SELECT fcm_token FROM device_push_tokens WHERE device_id=?")
      .bind(device.id)
      .first();
    const fcmToken = String(tokenRow?.fcm_token || "");
    if (!fcmToken) return { status: "NOT_REGISTERED" };

    const accessToken = await getGoogleAccessToken({
      project_id: projectId,
      client_email: clientEmail,
      private_key: privateKey,
    });
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: fcmToken,
            data: {
              event: "command_wakeup",
              commandId: String(commandId),
            },
            android: {
              priority: "HIGH",
              ttl: "60s",
            },
          },
        }),
      },
    );

    if (response.ok) return { status: "SENT" };

    const providerError = await response.json().catch(() => ({}));
    const providerText = JSON.stringify(providerError);
    if (
      response.status === 404 ||
      providerText.includes("UNREGISTERED") ||
      providerText.includes("registration-token-not-registered")
    ) {
      await db
        .prepare("DELETE FROM device_push_tokens WHERE device_id=? AND fcm_token=?")
        .bind(device.id, fcmToken)
        .run();
      return { status: "NOT_REGISTERED" };
    }
    return { status: "FAILED", reason: "FCM_REJECTED", httpStatus: response.status };
  } catch {
    return { status: "FAILED", reason: "DELIVERY_ERROR" };
  }
}
