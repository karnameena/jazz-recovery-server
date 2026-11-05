import { handleBluetoothHelperRoutes } from "./helper-routes.js";
import { handleAndroidAndRecoveryRoutes } from "./android-routes.js";
import { handleAuthAndCoreRoutes } from "./auth-routes.js";
import { handleAdminAndBillingRoutes } from "./admin-routes.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...JSON_HEADERS,
      ...Object.fromEntries(new Headers(extra).entries()),
    },
  });
}

function allowedWebOrigins(env) {
  return new Set(
    String(env.WEB_ORIGINS || env.WEB_ORIGIN || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );
}

function corsHeaders(request, env) {
  const headers = new Headers({ vary: "Origin" });
  const origin = request.headers.get("Origin");
  const allowed = allowedWebOrigins(env);

  if (origin && allowed.has(origin.replace(/\/+$/, ""))) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set(
      "access-control-allow-methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    headers.set(
      "access-control-allow-headers",
      "Content-Type, Authorization, X-Jazz-Lost-Device-Id, X-CSRF-Token",
    );
    headers.set("access-control-max-age", "600");
  }

  return headers;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin");
    const allowed = allowedWebOrigins(env);

    if (origin && !allowed.has(origin.replace(/\/+$/, ""))) {
      return json({ ok: false, error: "Origin not allowed" }, 403, cors);
    }

    if (request.method === "OPTIONS") {
      if (!origin) {
        return json({ ok: false, error: "Origin not allowed" }, 403, cors);
      }

      return new Response(null, {
        status: 204,
        headers: cors,
      });
    }

    // Jazz Recovery API Gateway
    if (url.pathname === "/" && request.method === "GET") {
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#070b18">
<title>Jazz Recovery · Service</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at 15% 10%, #1b2850 0, transparent 38%),
    radial-gradient(circle at 85% 80%, #241642 0, transparent 34%),
    #070b18;
  color: #f4f7ff;
  font: 15px/1.6 Inter, ui-sans-serif, system-ui,
    -apple-system, Segoe UI, sans-serif;
}

.panel {
  width: min(100%, 680px);
  padding: clamp(26px, 6vw, 54px);
  border: 1px solid #293657;
  border-radius: 26px;
  background: linear-gradient(
    145deg,
    rgba(17, 27, 55, .94),
    rgba(8, 13, 29, .96)
  );
  box-shadow: 0 28px 90px #0008;
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.mark {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border: 1px solid #286b82;
  border-radius: 16px;
  background: #0c2338;
  color: #68e4e6;
  font-size: 26px;
}

.eyebrow {
  color: #8da4d2;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: .22em;
}

.brand h1 {
  margin: 2px 0 0;
  font-size: 20px;
  letter-spacing: -.04em;
}

.status {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 34px 0 10px;
  color: #8bf0bf;
  font-size: 13px;
  font-weight: 700;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #5be5a1;
  box-shadow: 0 0 16px #5be5a1;
}

.intro {
  margin: 0;
  color: #aab8d3;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}

.links a {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 15px;
  border: 1px solid #34466e;
  border-radius: 12px;
  color: #dbe8ff;
  text-decoration: none;
  background: #111d35;
  transition: border-color .2s ease, background .2s ease;
}

.links a:hover {
  border-color: #63d9e6;
  background: #152744;
}

/* Developer Credit */

.foot {
  margin-top: 34px;
  padding-top: 20px;
  border-top: 1px solid #26334e;
  text-align: center;
  color: #91a4c7;
  font-size: 12px;
  letter-spacing: .25px;
}

.foot .heart {
  color: #ff7185;
  font-size: 14px;
  margin: 0 2px;
}

.foot strong {
  color: #68dce8;
  font-weight: 700;
}

@media (max-width: 480px) {
  .panel {
    padding: 26px 22px;
  }

  .brand h1 {
    font-size: 18px;
  }

  .links a {
    width: 100%;
    justify-content: center;
  }
}
</style>
</head>

<body>
<main class="panel">

  <div class="brand">
    <div class="mark">✦</div>
    <div>
      <div class="eyebrow">JAZZ RECOVERY</div>
      <h1>Recovery Service Gateway</h1>
    </div>
  </div>

  <div class="status">
    <span class="dot"></span>
    Worker endpoint is responding
  </div>

  <p class="intro">
    This is the Jazz Recovery API service.
    The website dashboard and Android Companion
    communicate with this secure service endpoint.
    Application functions are available through
    their documented API routes.
  </p>

  <nav class="links">
    <a href="/health">View API health ↗</a>
    <a href="https://developers.cloudflare.com/workers/"
       target="_blank"
       rel="noopener noreferrer">
      Worker platform ↗
    </a>
  </nav>

  <div class="foot">
    Developed with <span class="heart">❤️</span>
    by <strong>Gunakarna</strong>
  </div>

</main>
</body>
</html>`;

      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "referrer-policy": "strict-origin-when-cross-origin",
          ...Object.fromEntries(cors.entries()),
        },
      });
    }

    // Database health check
    if (url.pathname === "/health" && request.method === "GET") {
      try {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();

        if (result?.ok !== 1) {
          throw new Error("D1 health query failed");
        }

        return json(
          {
            ok: true,
            service: "jazz-recovery-api",
            database: "d1",
          },
          200,
          cors,
        );
      } catch {
        return json(
          {
            ok: false,
            error: "Database unavailable",
          },
          503,
          cors,
        );
      }
    }

    // Cookie-authenticated mutations require the exact configured website origin.
    // Android bearer-token routes are handled separately and do not use browser cookies.
    if (
      request.headers.get("Origin") &&
      !allowed.has(request.headers.get("Origin").replace(/\/+$/, ""))
    ) {
      return json({ ok: false, error: "Origin not allowed" }, 403, cors);
    }

    try {
      const adminBillingRouted = await handleAdminAndBillingRoutes(
        request,
        env,
        url,
      );

      const routed =
        adminBillingRouted ||
        (await handleAuthAndCoreRoutes(request, env, url));

      const recoveryRouted =
        routed ||
        (await handleAndroidAndRecoveryRoutes(request, env, url)) ||
        (await handleBluetoothHelperRoutes(request, env, url));

      if (recoveryRouted) {
        const headers = new Headers(recoveryRouted.headers);

        for (const [name, value] of cors.entries()) {
          headers.set(name, value);
        }

        return new Response(recoveryRouted.body, {
          status: recoveryRouted.status,
          statusText: recoveryRouted.statusText,
          headers,
        });
      }
    } catch (error) {
      const status = Number(error?.status) || 500;

      if (status >= 500) {
        console.error("[Jazz Recovery Worker]", JSON.stringify({ name: error?.name || "Error", message: String(error?.message || "Unknown error").slice(0, 500), code: error?.code || null, stack: String(error?.stack || "").slice(0, 1200) }));
      }

      return json(
        {
          ok: false,
          error:
            status < 500
              ? String(error?.message || "Request failed")
              : "Jazz Recovery API error",
        },
        status,
        cors,
      );
    }

    return json(
      {
        ok: false,
        error:
          "This API route has not yet been migrated. Existing production API must remain in service.",
      },
      501,
      cors,
    );
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const expired = await env.DB.prepare(
          `SELECT id FROM recovery_result_relays
           WHERE expires_at <= CURRENT_TIMESTAMP
           LIMIT 100`,
        ).all();

        const expiredIds = (expired.results || []).map((row) => row.id);

        if (expiredIds.length) {
          const marks = expiredIds.map(() => "?").join(",");

          await env.DB.prepare(
            `DELETE FROM recovery_result_relays
             WHERE id IN (${marks})`,
          )
            .bind(...expiredIds)
            .run();
        }

        await env.DB.prepare(
          `DELETE FROM sessions
           WHERE id IN (
             SELECT id FROM sessions
             WHERE expires_at <= CURRENT_TIMESTAMP
             LIMIT 100
           )`,
        ).run();

        await env.DB.prepare(
          `DELETE FROM auth_login_attempts
           WHERE id IN (
             SELECT id FROM auth_login_attempts
             WHERE attempted_at < datetime('now','-2 days')
             LIMIT 100
           )`,
        ).run();

        await env.DB.prepare(
          `DELETE FROM auth_recovery_attempts
           WHERE id IN (
             SELECT id FROM auth_recovery_attempts
             WHERE attempted_at < datetime('now','-2 days')
             LIMIT 100
           )`,
        ).run();

        await env.DB.prepare(
          `DELETE FROM auth_device_attempts
           WHERE id IN (
             SELECT id FROM auth_device_attempts
             WHERE attempted_at < datetime('now','-1 day')
             LIMIT 100
           )`,
        ).run();

        await env.DB.prepare(
          `DELETE FROM recovery_helper_encounters
           WHERE encounter_id IN (
             SELECT encounter_id FROM recovery_helper_encounters
             WHERE expires_at <= CURRENT_TIMESTAMP
             LIMIT 100
           )`,
        ).run();

        await env.DB.prepare(
          `DELETE FROM recovery_beacon_tokens
           WHERE token_hash IN (
             SELECT token_hash FROM recovery_beacon_tokens
             WHERE expires_at <= CURRENT_TIMESTAMP
             LIMIT 100
           )`,
        ).run();
      })(),
    );
  },
};

// import { handleBluetoothHelperRoutes } from "./helper-routes.js";
// import { handleAndroidAndRecoveryRoutes } from "./android-routes.js";
// import { handleAuthAndCoreRoutes } from "./auth-routes.js";
// import { handleAdminAndBillingRoutes } from "./admin-routes.js";

// const JSON_HEADERS = {
//   "content-type": "application/json; charset=utf-8",
//   "cache-control": "no-store",
//   "x-content-type-options": "nosniff",
//   "referrer-policy": "strict-origin-when-cross-origin",
//   "x-frame-options": "DENY",
// };

// function json(body, status = 200, extra = {}) {
//   return new Response(JSON.stringify(body), {
//     status,
//     headers: { ...JSON_HEADERS, ...Object.fromEntries(new Headers(extra).entries()) },
//   });
// }

// function allowedWebOrigins(env) {
//   return new Set(
//     String(env.WEB_ORIGINS || env.WEB_ORIGIN || "")
//       .split(",")
//       .map((origin) => origin.trim().replace(/\/+$/, ""))
//       .filter(Boolean)
//   );
// }

// function corsHeaders(request, env) {
//   const headers = new Headers({ vary: "Origin" });
//   const origin = request.headers.get("Origin");
//   const allowed = allowedWebOrigins(env);

//   if (origin && allowed.has(origin.replace(/\/+$/, ""))) {
//     headers.set("access-control-allow-origin", origin);
//     headers.set("access-control-allow-credentials", "true");
//     headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
//     headers.set("access-control-allow-headers", "Content-Type, Authorization, X-Jazz-Lost-Device-Id, X-CSRF-Token");
//     headers.set("access-control-max-age", "600");
//   }

//   return headers;
// }

// export default {
//   async fetch(request, env) {
//     const url = new URL(request.url);
//     const cors = corsHeaders(request, env);
//     const origin = request.headers.get("Origin");
//     const allowed = allowedWebOrigins(env);

//     if (origin && (!origin || !allowed.has(origin.replace(/\/+$/, "")))) return json({ ok: false, error: "Origin not allowed" }, 403, cors);
//     if (request.method === "OPTIONS") {
//       if (!origin || (!origin || !allowed.has(origin.replace(/\/+$/, "")))) return json({ ok: false, error: "Origin not allowed" }, 403, cors);
//       return new Response(null, { status: 204, headers: cors });
//     }

//     if (url.pathname === "/" && request.method === "GET") {
//       const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#070b18"><title>Jazz Recovery · Service</title><style>
//       *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 10%,#1b2850 0,transparent 38%),radial-gradient(circle at 85% 80%,#241642 0,transparent 34%),#070b18;color:#f4f7ff;font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.panel{width:min(100%,680px);padding:clamp(26px,6vw,54px);border:1px solid #293657;border-radius:26px;background:linear-gradient(145deg,rgba(17,27,55,.94),rgba(8,13,29,.96));box-shadow:0 28px 90px #0008}.brand{display:flex;align-items:center;gap:14px}.mark{display:grid;place-items:center;width:54px;height:54px;border:1px solid #286b82;border-radius:16px;background:#0c2338;color:#68e4e6;font-size:26px}.eyebrow{color:#8da4d2;font-size:10px;font-weight:800;letter-spacing:.22em}.brand h1{margin:2px 0 0;font-size:20px;letter-spacing:-.04em}.status{display:flex;align-items:center;gap:9px;margin:34px 0 10px;color:#8bf0bf;font-size:13px;font-weight:700}.dot{width:8px;height:8px;border-radius:50%;background:#5be5a1;box-shadow:0 0 16px #5be5a1}.intro{margin:0;color:#aab8d3}.links{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}.links a{display:inline-flex;align-items:center;gap:8px;padding:11px 15px;border:1px solid #34466e;border-radius:12px;color:#dbe8ff;text-decoration:none;background:#111d35}.links a:hover{border-color:#63d9e6}.foot{margin-top:34px;padding-top:18px;border-top:1px solid #26334e;color:#7586a8;font-size:11px}</style></head><body><main class="panel"><div class="brand"><div class="mark">✦</div><div><div class="eyebrow">JAZZ RECOVERY</div><h1>Recovery Service Gateway</h1></div></div><div class="status"><span class="dot"></span>Worker endpoint is responding</div><p class="intro">This is the Jazz Recovery API service. The website dashboard and Android Companion communicate with this secure service endpoint. Application functions are available through their documented API routes.</p><nav class="links"><a href="/health">View API health ↗</a><a href="https://developers.cloudflare.com/workers/">Worker platform ↗</a></nav><div class="foot">Developed by gunakarna · Jazz Recovery secure service endpoint.</div></main></body></html>`;
//       return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "strict-origin-when-cross-origin", ...Object.fromEntries(cors.entries()) } });
//     }

//     if (url.pathname === "/health" && request.method === "GET") {
//       try {
//         const result = await env.DB.prepare("SELECT 1 AS ok").first();
//         if (result?.ok !== 1) throw new Error("D1 health query failed");
//         return json({ ok: true, service: "jazz-recovery-api", database: "d1" }, 200, cors);
//       } catch {
//         return json({ ok: false, error: "Database unavailable" }, 503, cors);
//       }
//     }

//     // Cookie-authenticated mutations require the exact configured website origin.
//     // Android bearer-token routes are handled separately and do not use browser cookies.
//     if (request.headers.get("Origin") && !allowed.has(request.headers.get("Origin").replace(/\/+$/, ""))) {
//       return json({ ok: false, error: "Origin not allowed" }, 403, cors);
//     }
//     try {
//       const adminBillingRouted = await handleAdminAndBillingRoutes(request, env, url);
//       const routed = adminBillingRouted || await handleAuthAndCoreRoutes(request, env, url);
//       const recoveryRouted = routed || await handleAndroidAndRecoveryRoutes(request, env, url) || await handleBluetoothHelperRoutes(request, env, url);
//       if (recoveryRouted) {
//         const headers = new Headers(recoveryRouted.headers);
//         for (const [name, value] of cors.entries()) headers.set(name, value);
//         return new Response(recoveryRouted.body, { status: recoveryRouted.status, statusText: recoveryRouted.statusText, headers });
//       }
//     } catch (error) {
//       const status = Number(error?.status) || 500;
//       if (status >= 500) console.error("[Jazz Recovery Worker]", JSON.stringify({ name: error?.name || "Error", message: String(error?.message || "Unknown error").slice(0, 500), code: error?.code || null, stack: String(error?.stack || "").slice(0, 1200) }));
//       return json({ ok: false, error: status < 500 ? String(error.message || "Request failed") : "Jazz Recovery API error" }, status, cors);
//     }
//     return json({
//       ok: false,
//       error: "This API route has not yet been migrated. Existing production API must remain in service."
//     }, 501, cors);
//   },

//   async scheduled(controller, env, ctx) {
//     ctx.waitUntil((async () => {
//       const expired = await env.DB.prepare("SELECT id FROM recovery_result_relays WHERE expires_at<=CURRENT_TIMESTAMP LIMIT 100").all();
//       const expiredIds = (expired.results || []).map(row => row.id);
//       if (expiredIds.length) {
//         const marks = expiredIds.map(() => "?").join(",");
//         await env.DB.prepare(`DELETE FROM recovery_result_relays WHERE id IN (${marks})`).bind(...expiredIds).run();
//       }
//       await env.DB.prepare("DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at<=CURRENT_TIMESTAMP LIMIT 100)").run();
//       await env.DB.prepare("DELETE FROM auth_login_attempts WHERE id IN (SELECT id FROM auth_login_attempts WHERE attempted_at<datetime('now','-2 days') LIMIT 100)").run();
//       await env.DB.prepare("DELETE FROM auth_recovery_attempts WHERE id IN (SELECT id FROM auth_recovery_attempts WHERE attempted_at<datetime('now','-2 days') LIMIT 100)").run();
//       await env.DB.prepare("DELETE FROM auth_device_attempts WHERE id IN (SELECT id FROM auth_device_attempts WHERE attempted_at<datetime('now','-1 day') LIMIT 100)").run();
//       await env.DB.prepare("DELETE FROM recovery_helper_encounters WHERE encounter_id IN (SELECT encounter_id FROM recovery_helper_encounters WHERE expires_at<=CURRENT_TIMESTAMP LIMIT 100)").run();
//       await env.DB.prepare("DELETE FROM recovery_beacon_tokens WHERE token_hash IN (SELECT token_hash FROM recovery_beacon_tokens WHERE expires_at<=CURRENT_TIMESTAMP LIMIT 100)").run();
//     })());
//   },
// };
