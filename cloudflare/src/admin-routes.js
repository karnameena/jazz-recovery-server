import {
  getSession, hashSecret, validatePassword, verifySecret
} from "./security.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
async function bodyOf(request, max = 32768) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > max) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("Invalid JSON request."), { status: 400 }); }
}
function cleanDate(value, env = {}) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  // datetime-local inputs contain no timezone. Interpret those values in the
  // configured application timezone (India by default), not the Worker UTC zone.
  const localMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  let date;
  if (localMatch) {
    const [, y, mo, d, h, mi, sec = "0", fraction = "0"] = localMatch;
    const parts = [Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(sec)];
    const [year, month, day, hour, minute, second] = parts;
    const offsetMinutes = Number(env.APP_TIME_ZONE_OFFSET_MINUTES ?? 330);
    if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840) {
      throw Object.assign(new Error("Invalid application timezone configuration."), { status: 500 });
    }
    const localUtc = Date.UTC(year, month - 1, day, hour, minute, second, Number(fraction.padEnd(3, "0")));
    const check = new Date(localUtc);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day || check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) {
      throw Object.assign(new Error("Invalid date value."), { status: 400 });
    }
    date = new Date(localUtc - offsetMinutes * 60_000);
  } else {
    date = new Date(raw);
  }
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error("Invalid date value."), { status: 400 });
  return date.toISOString().slice(0, 19).replace("T", " ");
}
function dateRange(start, end, env = {}) {
  const a = cleanDate(start, env), b = cleanDate(end, env);
  if (!a || !b || Date.parse(`${b.replace(" ", "T")}Z`) <= Date.parse(`${a.replace(" ", "T")}Z`)) {
    throw Object.assign(new Error("A valid start date earlier than the expiry date is required."), { status: 400 });
  }
  return [a, b];
}
function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}
async function codeHash(env, code) {
  const pepper = String(env.JAZZ_DISCOUNT_CODE_PEPPER || "");
  if (pepper.length < 32) throw Object.assign(new Error("Discount-code security configuration is missing."), { status: 503 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalizeCode(code)));
  return [...new Uint8Array(sig)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function equalSecret(a, b) {
  const left = new TextEncoder().encode(String(a || ""));
  const right = new TextEncoder().encode(String(b || ""));
  let diff = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let i = 0; i < size; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}
async function audit(db, actorId, action, details = {}) {
  await db.prepare("INSERT INTO billing_audit(actor_user_id,action,details) VALUES(?,?,?)")
    .bind(actorId ?? null, action, JSON.stringify(details)).run();
}
async function sessionFor(request, env) {
  return getSession(env.DB, request);
}
async function requireBillingAdmin(request, env) {
  const session = await sessionFor(request, env);
  if (!session) return { error: json({ ok: false, error: "Authentication required" }, 401) };

  // The Owner Admin may access the billing dashboard without being added
  // to the separate billing_admins role table.
  if (String(session.username || "").toLowerCase() === "guna_owner") {
    return { session };
  }

  const role = await env.DB.prepare("SELECT 1 AS yes FROM billing_admins WHERE user_id=?").bind(session.user_id).first();
  if (!role) return { error: json({ ok: false, error: "Billing administrator access required" }, 403) };
  return { session };
}
async function requireOwner(request, env) {
  const session = await sessionFor(request, env);
  if (!session) return { error: json({ ok: false, error: "Authentication required" }, 401) };
  if (String(session.username).toLowerCase() !== "guna_owner") return { error: json({ ok: false, error: "Owner administrator access required" }, 403) };
  return { session };
}
async function oneTimeBootstrap(request, env, kind) {
  const expected = kind === "owner" ? env.JAZZ_OWNER_ADMIN_BOOTSTRAP_SECRET : env.JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET;
  if (!expected || String(expected).length < 32) return json({ ok: false, error: "Administrator bootstrap security is not configured." }, 503);
  const body = await bodyOf(request);
  const supplied = String(body.bootstrapSecret || "");
  if (!equalSecret(supplied, expected)) return json({ ok: false, error: "Invalid bootstrap secret." }, 401);
  const username = kind === "owner" ? "guna_owner" : "guna_billing";
  if (String(body.username || "").trim().toLowerCase() !== username) return json({ ok: false, error: `The bootstrap username must be ${username}.` }, 400);
  const password = String(body.password || "");
  const passwordProblem = validatePassword(password);
  if (passwordProblem) return json({ ok: false, error: passwordProblem }, 400);

  const existing = await env.DB.prepare("SELECT id FROM users WHERE lower(username)=lower(?)").bind(username).first();
  if (existing) return json({ ok: false, error: "This administrator account already exists. Bootstrap is one-time." }, 409);

  if (kind === "billing") {
    const anyAdmin = await env.DB.prepare("SELECT user_id FROM billing_admins LIMIT 1").first();
    if (anyAdmin) return json({ ok: false, error: "A Billing Admin is already configured. Bootstrap is one-time." }, 409);
  } else {
    const marker = await env.DB.prepare("SELECT id FROM billing_audit WHERE action='OWNER_ADMIN_BOOTSTRAPPED' LIMIT 1").first();
    if (marker) return json({ ok: false, error: "Owner Admin bootstrap has already been completed." }, 409);
  }

  const id = Number((BigInt("0x" + [...crypto.getRandomValues(new Uint8Array(7))].map(x => x.toString(16).padStart(2, "0")).join("")) & ((1n << 52n) - 1n)) + 1n);
  const statements = [
    env.DB.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,?)").bind(id, username, await hashSecret(password)),
  ];
  if (kind === "billing") statements.push(env.DB.prepare("INSERT INTO billing_admins(user_id) VALUES(?)").bind(id));
  statements.push(env.DB.prepare("INSERT INTO billing_audit(actor_user_id,action,details) VALUES(?,?,?)")
    .bind(id, kind === "owner" ? "OWNER_ADMIN_BOOTSTRAPPED" : "BILLING_ADMIN_BOOTSTRAPPED", JSON.stringify({ username })));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ""))) return json({ ok: false, error: "Administrator already exists or bootstrap has already been completed." }, 409);
    throw error;
  }
  return json({ ok: true, username, message: "Administrator account created. Sign in using the normal login endpoint." }, 201);
}

async function billingStatus(request, env) {
  const session = await sessionFor(request, env);
  if (!session) return json({ ok: false, error: "Authentication required" }, 401);
  const [trial, subscription, admin] = await Promise.all([
    env.DB.prepare("SELECT starts_at,expires_at FROM billing_trials WHERE user_id=?").bind(session.user_id).first(),
    env.DB.prepare(`SELECT id,status,starts_at,expires_at,amount_paid_paise,plan_type FROM billing_subscriptions
      WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).bind(session.user_id).first(),
    env.DB.prepare("SELECT 1 AS yes FROM billing_admins WHERE user_id=?").bind(session.user_id).first(),
  ]);
  const now = Date.now();
  const toMs = value => value ? Date.parse(String(value).replace(" ", "T") + (String(value).includes("Z") ? "" : "Z")) : 0;
  const trialActive = Boolean(trial && toMs(trial.starts_at) <= now && toMs(trial.expires_at) > now);
  const trialPending = Boolean(trial && toMs(trial.starts_at) > now);
  const subscriptionActive = Boolean(subscription && ["active", "complimentary"].includes(subscription.status) && toMs(subscription.starts_at) <= now && toMs(subscription.expires_at) > now);
  const isBillingAdmin = Boolean(admin);
  const isOwnerAdmin = String(session.username || "").toLowerCase() === "guna_owner";
  const hasAdminAccess = isBillingAdmin || isOwnerAdmin;
  const access = hasAdminAccess || subscriptionActive ? "subscribed" : trialActive ? "trial" : trialPending ? "trial_pending" : "expired";
  const pendingPayment = await env.DB.prepare(`SELECT id,plan_type,amount_paise,status,created_at FROM billing_payment_intents
    WHERE user_id=? AND status IN ('pending','awaiting_dynamic_checkout') ORDER BY created_at DESC LIMIT 1`).bind(session.user_id).first();
  return json({
    ok: true,
    trial: trial ? { startsAt: trial.starts_at, expiresAt: trial.expires_at, active: trialActive } : null,
    subscription: subscription ? { ...subscription, active: subscriptionActive } : null,
    pendingPayment: pendingPayment || null,
    access,
    canUsePaidFeatures: hasAdminAccess || subscriptionActive || trialActive,
    isBillingAdmin,
    isOwnerAdmin,
    plans: { monthly: 4900, annual: 39900 },
    paymentLinks: { monthly: env.RAZORPAY_MONTHLY_PAYMENT_LINK || "", annual: env.RAZORPAY_ANNUAL_PAYMENT_LINK || "" },
  });
}
async function createDiscount(request, env, actor) {
  const body = await bodyOf(request);
  const label = String(body.label || "").trim();
  const percent = Number(body.percentOff);
  const perUser = Number(body.perUserLimit ?? 1);
  const max = body.maxRedemptions == null || body.maxRedemptions === "" ? null : Number(body.maxRedemptions);
  const code = normalizeCode(body.code) || `JAZZ-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  if (!label || label.length > 100) return json({ ok: false, error: "A label of up to 100 characters is required." }, 400);
  if (![10, 20, 50].includes(percent)) return json({ ok: false, error: "Discount must be 10%, 20% or 50%." }, 400);
  if (!/^[A-Z0-9-]{4,40}$/.test(code)) return json({ ok: false, error: "Discount code must contain 4–40 letters, numbers or hyphens." }, 400);
  if (!Number.isInteger(perUser) || perUser < 1 || perUser > 1000000 || (max != null && (!Number.isInteger(max) || max < 1))) return json({ ok: false, error: "Invalid redemption limit." }, 400);
  const starts = cleanDate(body.startsAt || new Date().toISOString(), env);
  const expires = body.expiresAt ? cleanDate(body.expiresAt, env) : null;
  const trialFrom = body.trialEligibleFrom ? cleanDate(body.trialEligibleFrom, env) : null;
  const trialUntil = body.trialEligibleUntil ? cleanDate(body.trialEligibleUntil, env) : null;
  if (expires && Date.parse(`${expires.replace(" ", "T")}Z`) <= Date.parse(`${starts.replace(" ", "T")}Z`)) return json({ ok: false, error: "Expiry must be after the start date." }, 400);
  if ((trialFrom && !trialUntil) || (!trialFrom && trialUntil) || (trialFrom && Date.parse(`${trialUntil.replace(" ", "T")}Z`) <= Date.parse(`${trialFrom.replace(" ", "T")}Z`))) return json({ ok: false, error: "Provide a valid trial eligibility date range." }, 400);
  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(`INSERT INTO billing_discount_codes
      (id,code_hash,label,percent_off,active,starts_at,expires_at,max_redemptions,eligible_plan,per_user_limit,trial_eligible_from,trial_eligible_until,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, await codeHash(env, code), label, percent, body.active === false ? 0 : 1, starts, expires, max, "annual", perUser, trialFrom, trialUntil, actor.user_id).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ""))) return json({ ok: false, error: "That discount code already exists." }, 409);
    throw error;
  }
  await audit(env.DB, actor.user_id, "DISCOUNT_CODE_CREATED", { id, label, percentOff: percent });
  return json({ ok: true, id, code, label, percentOff: percent }, 201);
}
async function updateDiscount(request, env, actor, id) {
  const body = await bodyOf(request);
  const current = await env.DB.prepare("SELECT * FROM billing_discount_codes WHERE id=?").bind(id).first();
  if (!current) return json({ ok: false, error: "Discount code not found." }, 404);
  const label = String(body.label ?? current.label).trim();
  const percent = Number(body.percentOff ?? current.percent_off);
  const perUser = Number(body.perUserLimit ?? current.per_user_limit);
  const max = body.maxRedemptions === undefined ? current.max_redemptions : (body.maxRedemptions == null || body.maxRedemptions === "" ? null : Number(body.maxRedemptions));
  if (!label || label.length > 100 || ![10, 20, 50].includes(percent) || !Number.isInteger(perUser) || perUser < 1 || (max != null && (!Number.isInteger(max) || max < Number(current.redeemed_count)))) return json({ ok: false, error: "Invalid discount-code settings." }, 400);
  const starts = cleanDate(body.startsAt ?? current.starts_at, env);
  const expires = body.expiresAt === undefined ? current.expires_at : (body.expiresAt ? cleanDate(body.expiresAt, env) : null);
  const trialFrom = body.trialEligibleFrom === undefined ? current.trial_eligible_from : (body.trialEligibleFrom ? cleanDate(body.trialEligibleFrom, env) : null);
  const trialUntil = body.trialEligibleUntil === undefined ? current.trial_eligible_until : (body.trialEligibleUntil ? cleanDate(body.trialEligibleUntil, env) : null);
  if (expires && Date.parse(`${expires.replace(" ", "T")}Z`) <= Date.parse(`${starts.replace(" ", "T")}Z`)) return json({ ok: false, error: "Expiry must be after the start date." }, 400);
  let hash = current.code_hash;
  if (body.code) hash = await codeHash(env, body.code);
  try {
    await env.DB.prepare(`UPDATE billing_discount_codes SET code_hash=?,label=?,percent_off=?,starts_at=?,expires_at=?,
      max_redemptions=?,per_user_limit=?,trial_eligible_from=?,trial_eligible_until=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(hash, label, percent, starts, expires, max, perUser, trialFrom, trialUntil, id).run();
  } catch (error) {
    if (/unique|constraint/i.test(String(error?.message || ""))) return json({ ok: false, error: "Replacement discount code already exists." }, 409);
    throw error;
  }
  await audit(env.DB, actor.user_id, "DISCOUNT_CODE_UPDATED", { id });
  return json({ ok: true });
}
async function validateDiscount(request, env, session) {
  const body = await bodyOf(request);
  if (String(body.plan || "annual") !== "annual") return json({ ok: false, valid: false, error: "Discount codes are available only for the annual plan." }, 400);
  const code = normalizeCode(body.code);
  if (!code) return json({ ok: true, valid: false, error: "Enter a discount code." }, 400);
  const row = await env.DB.prepare("SELECT * FROM billing_discount_codes WHERE code_hash=?").bind(await codeHash(env, code)).first();
  const now = Date.now();
  const toMs = v => v ? Date.parse(String(v).replace(" ", "T") + "Z") : 0;
  if (!row || !row.active || toMs(row.starts_at) > now || (row.expires_at && toMs(row.expires_at) <= now)) return json({ ok: true, valid: false, error: "This discount code is not available." });
  if (row.max_redemptions != null && Number(row.redeemed_count) >= Number(row.max_redemptions)) return json({ ok: true, valid: false, error: "This discount code has reached its redemption limit." });
  const used = await env.DB.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").bind(row.id, session.user_id).first();
  if (Number(used?.total || 0) >= Number(row.per_user_limit || 1)) return json({ ok: true, valid: false, error: "This account has reached the discount-code usage limit." });
  const amountPaise = Math.round(39900 * (100 - Number(row.percent_off)) / 100);
  return json({ ok: true, valid: true, percentOff: row.percent_off, amountPaise, label: row.label });
}
async function adminRoute(request, env, url, actor) {
  const db = env.DB, path = url.pathname, method = request.method;
  if (method === "GET" && path === "/api/billing/admin/discount-codes") {
    const rows = await db.prepare("SELECT id,label,percent_off,active,starts_at,expires_at,trial_eligible_from,trial_eligible_until,max_redemptions,redeemed_count,eligible_plan,per_user_limit FROM billing_discount_codes ORDER BY created_at DESC").all();
    return json({ ok: true, items: rows.results || [] });
  }
  if (method === "POST" && path === "/api/billing/admin/discount-codes") return createDiscount(request, env, actor);
  let match = path.match(/^\/api\/billing\/admin\/discount-codes\/([^/]+)\/(update|enable|disable|delete|usage)$/);
  if (match) {
    const id = decodeURIComponent(match[1]), action = match[2];
    if (method === "POST" && action === "update") return updateDiscount(request, env, actor, id);
    if (method === "POST" && ["enable", "disable"].includes(action)) {
      const result = await db.prepare("UPDATE billing_discount_codes SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(action === "enable" ? 1 : 0, id).run();
      if (!result.meta?.changes) return json({ ok: false, error: "Discount code not found." }, 404);
      await audit(db, actor.user_id, `DISCOUNT_CODE_${action.toUpperCase()}D`, { id });
      return json({ ok: true });
    }
    if (method === "POST" && action === "delete") {
      const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=?").bind(id).first();
      if (Number(used?.total || 0) > 0) return json({ ok: false, error: "This code has redemption history and can only be disabled." }, 409);
      const result = await db.prepare("DELETE FROM billing_discount_codes WHERE id=?").bind(id).run();
      if (!result.meta?.changes) return json({ ok: false, error: "Discount code not found." }, 404);
      await audit(db, actor.user_id, "DISCOUNT_CODE_DELETED", { id });
      return json({ ok: true });
    }
    if (method === "GET" && action === "usage") {
      const items = await db.prepare(`SELECT r.id,u.username,r.amount_paid_paise,r.created_at
        FROM billing_discount_redemptions r JOIN users u ON u.id=r.user_id
        WHERE r.discount_code_id=? ORDER BY r.created_at DESC`).bind(id).all();
      return json({ ok: true, items: items.results || [] });
    }
  }
  if (method === "GET" && path === "/api/billing/admin/user-ledger") {
    const rows = await db.prepare(`SELECT u.id AS user_id,u.username,t.starts_at AS trial_started_at,t.expires_at AS trial_ends_at,
      CASE WHEN t.starts_at<=CURRENT_TIMESTAMP AND t.expires_at>CURRENT_TIMESTAMP THEN 1 ELSE 0 END AS trial_active,
      s.id AS subscription_id,s.plan_type AS subscription_plan,s.status AS subscription_status,
      s.starts_at AS subscription_started_at,s.expires_at AS subscription_ends_at,s.amount_paid_paise,
      (SELECT COUNT(*) FROM billing_payment_intents pi WHERE pi.user_id=u.id AND pi.status IN ('pending','awaiting_dynamic_checkout')) AS pending_payments
      FROM users u LEFT JOIN billing_trials t ON t.user_id=u.id
      LEFT JOIN billing_subscriptions s ON s.id=(SELECT s2.id FROM billing_subscriptions s2 WHERE s2.user_id=u.id ORDER BY s2.created_at DESC,s2.id DESC LIMIT 1)
      WHERE lower(u.username)<>'guna_owner' AND u.id<>?
      ORDER BY u.created_at DESC`).bind(actor.user_id).all();
    return json({ ok: true, items: rows.results || [] });
  }
  if (method === "GET" && path === "/api/billing/admin/payment-intents") {
    const rows = await db.prepare(`SELECT pi.*,u.username FROM billing_payment_intents pi JOIN users u ON u.id=pi.user_id ORDER BY pi.created_at DESC LIMIT 500`).all();
    return json({ ok: true, items: rows.results || [] });
  }
  if (method === "GET" && path === "/api/billing/admin/audit") {
    const rows = await db.prepare(`SELECT id,actor_user_id,action,details,created_at FROM billing_audit ORDER BY created_at DESC,id DESC LIMIT 500`).all();
    return json({ ok: true, items: (rows.results || []).map(r => ({ ...r, details: safeJson(r.details) })) });
  }
  if (method === "GET" && path === "/api/billing/admin/subscriptions") {
    const rows = await db.prepare(`SELECT s.*,u.username FROM billing_subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 500`).all();
    return json({ ok: true, items: rows.results || [] });
  }
  if (method === "GET" && path === "/api/billing/admin/payments") {
    const rows = await db.prepare(`SELECT p.*,u.username FROM billing_payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 500`).all();
    return json({ ok: true, items: rows.results || [] });
  }
  match = path.match(/^\/api\/billing\/admin\/users\/(\d+)\/(trial|subscription|delete)$/);
  if (match && method === "POST") {
    const userId = Number(match[1]), action = match[2];
    const user = await db.prepare("SELECT id,username FROM users WHERE id=?").bind(userId).first();
    if (!user) return json({ ok: false, error: "User not found." }, 404);
    if (user.username.toLowerCase() === "guna_owner" || (await db.prepare("SELECT 1 FROM billing_admins WHERE user_id=?").bind(userId).first())) return json({ ok: false, error: "Administrator accounts cannot be changed or deleted through customer billing tools." }, 403);
    const body = await bodyOf(request);
    if (action === "trial") {
      const [starts, expires] = dateRange(body.startsAt, body.expiresAt, env);
      await db.prepare(`INSERT INTO billing_trials(user_id,starts_at,expires_at) VALUES(?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET starts_at=excluded.starts_at,expires_at=excluded.expires_at`)
        .bind(userId, starts, expires).run();
      await audit(db, actor.user_id, "USER_TRIAL_UPDATED", { userId, startsAt: starts, expiresAt: expires });
      return json({ ok: true });
    }
    if (action === "subscription") {
      const [starts, expires] = dateRange(body.startsAt, body.expiresAt, env);
      const status = String(body.status || "");
      const plan = String(body.planType || "annual");
      if (!["active", "expired", "refunded", "complimentary"].includes(status) || !["monthly", "annual"].includes(plan)) return json({ ok: false, error: "Invalid subscription status or plan." }, 400);
      const latest = await db.prepare("SELECT id FROM billing_subscriptions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1").bind(userId).first();
      if (!latest) return json({ ok: false, error: "No subscription record exists for this user. This endpoint only updates existing subscriptions." }, 409);
      await db.prepare("UPDATE billing_subscriptions SET starts_at=?,expires_at=?,status=?,plan_type=? WHERE id=? AND user_id=?")
        .bind(starts, expires, status, plan, latest.id, userId).run();
      await audit(db, actor.user_id, "USER_SUBSCRIPTION_UPDATED", { userId, subscriptionId: latest.id, status, plan });
      return json({ ok: true });
    }
    if (action === "delete") {
      if (String(body.confirmUsername || "") !== user.username) return json({ ok: false, error: "Username confirmation did not match." }, 400);
      await audit(db, actor.user_id, "USER_ACCOUNT_DELETED", { userId, username: user.username });
      await db.prepare("DELETE FROM users WHERE id=?").bind(userId).run();
      return json({ ok: true });
    }
  }
  return null;
}
function safeJson(value) {
  try { return JSON.parse(String(value || "{}")); } catch { return {}; }
}
async function checkout(request, env, session) {
  const body = await bodyOf(request);
  const plan = String(body.plan || "");
  if (!["monthly", "annual"].includes(plan)) return json({ ok: false, error: "Choose a valid subscription plan." }, 400);
  let amount = plan === "monthly" ? 4900 : 39900;
  let discountId = null;
  if (plan === "annual" && body.code) {
    const validated = await validateDiscount(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify({ code: body.code, plan }) }), env, session);
    const data = await validated.json();
    if (!data.valid) return json({ ok: false, error: data.error || "Discount code is invalid." }, 400);
    amount = Number(data.amountPaise);
    const row = await env.DB.prepare("SELECT id FROM billing_discount_codes WHERE code_hash=?").bind(await codeHash(env, body.code)).first();
    discountId = row?.id || null;
  }
  const existing = await env.DB.prepare("SELECT id,status FROM billing_payment_intents WHERE user_id=? AND status IN ('pending','awaiting_dynamic_checkout') LIMIT 1").bind(session.user_id).first();
  if (existing) return json({ ok: true, pending: true, message: "A payment request is already pending. It must be verified before another checkout can be created." });
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO billing_payment_intents(id,user_id,plan_type,amount_paise,discount_code_id,status)
    VALUES(?,?,?,?,?,'awaiting_dynamic_checkout')`).bind(id, session.user_id, plan, amount, discountId).run();
  return json({ ok: true, pending: true, message: "Payment gateway configuration is not available yet. No payment or subscription has been activated." }, 202);
}

export async function handleAdminAndBillingRoutes(request, env, url) {
  const path = url.pathname, method = request.method;
  if (method === "POST" && path === "/api/admin/bootstrap/owner") return oneTimeBootstrap(request, env, "owner");
  if (method === "POST" && path === "/api/admin/bootstrap/billing") return oneTimeBootstrap(request, env, "billing");

  if (path === "/api/billing/status" && method === "GET") return billingStatus(request, env);
  if (path === "/api/billing/discount/validate" && method === "POST") {
    const session = await sessionFor(request, env);
    if (!session) return json({ ok: false, error: "Authentication required" }, 401);
    return validateDiscount(request, env, session);
  }
  if (path === "/api/billing/checkout" && method === "POST") {
    const session = await sessionFor(request, env);
    if (!session) return json({ ok: false, error: "Authentication required" }, 401);
    return checkout(request, env, session);
  }

  if (path.startsWith("/api/billing/admin/")) {
    const auth = await requireBillingAdmin(request, env);
    if (auth.error) return auth.error;
    const result = await adminRoute(request, env, url, auth.session);
    if (result) return result;
  }

  if (path.startsWith("/api/owner/admin/")) {
    const auth = await requireOwner(request, env);
    if (auth.error) return auth.error;
    const db = env.DB, actor = auth.session;
    if (method === "GET" && path === "/api/owner/admin/users") {
      const rows = await db.prepare(`SELECT u.id,u.username,u.created_at,u.updated_at,
        EXISTS(SELECT 1 FROM billing_admins b WHERE b.user_id=u.id) AS is_billing_admin,
        (SELECT COUNT(*) FROM devices d WHERE d.user_id=u.id) AS device_count
        FROM users u ORDER BY u.created_at DESC LIMIT 1000`).all();
      return json({ ok: true, items: rows.results || [] });
    }
    if (method === "GET" && path === "/api/owner/admin/billing-admins") {
      const rows = await db.prepare(`SELECT u.id,u.username,b.created_at FROM billing_admins b JOIN users u ON u.id=b.user_id ORDER BY b.created_at`).all();
      return json({ ok: true, items: rows.results || [] });
    }
    if (method === "POST" && path === "/api/owner/admin/billing-admins/grant") {
      const body = await bodyOf(request);
      const user = await db.prepare("SELECT id,username FROM users WHERE id=?").bind(Number(body.userId)).first();
      if (!user) return json({ ok: false, error: "User not found." }, 404);
      if (user.username.toLowerCase() === "guna_owner") return json({ ok: false, error: "Owner Admin is a separate role." }, 403);
      await db.prepare("INSERT OR IGNORE INTO billing_admins(user_id) VALUES(?)").bind(user.id).run();
      await audit(db, actor.user_id, "BILLING_ADMIN_GRANTED", { userId: user.id, username: user.username });
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/owner/admin/billing-admins/revoke") {
      const body = await bodyOf(request);
      const user = await db.prepare("SELECT id,username FROM users WHERE id=?").bind(Number(body.userId)).first();
      if (!user) return json({ ok: false, error: "Administrator not found." }, 404);
      if (user.username.toLowerCase() === "guna_owner") return json({ ok: false, error: "Owner Admin cannot be changed through Billing Admin role management." }, 403);
      await db.prepare("DELETE FROM billing_admins WHERE user_id=?").bind(user.id).run();
      await audit(db, actor.user_id, "BILLING_ADMIN_REVOKED", { userId: user.id, username: user.username });
      return json({ ok: true });
    }
    return json({ ok: false, error: "Owner Admin route not found." }, 404);
  }
  return null;
}
