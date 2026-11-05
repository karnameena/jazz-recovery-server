import crypto from "node:crypto";
import { PLAN_PRICES_PAISE, PLAN_DURATIONS_MONTHS, PLAN_CONFIG } from "./subscription-config.mjs";

const PAYMENT_LINKS = Object.freeze({
  monthly: "https://rzp.io/rzp/PEy4Ttqm",
  annual: "https://rzp.io/rzp/pOzil1FJ"
});
const ALLOWED_DISCOUNTS = new Set([10, 20, 50]);

function normalizePlan(value) {
  const plan = String(value || "annual").toLowerCase();
  if (!Object.hasOwn(PLAN_PRICES_PAISE, plan)) throw Object.assign(new Error("Choose a valid subscription plan."), { status: 400 });
  return plan;
}
function parseDate(value, label, optional = false) {
  if ((value == null || value === "") && optional) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error(`${label} must be a valid date.`), { status: 400 });
  return date.toISOString();
}
export function planExpiry(startMs, plan) {
  plan = normalizePlan(plan);
  const start = new Date(startMs);
  const target = new Date(startMs);
  const day = start.getUTCDate();
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + PLAN_DURATIONS_MONTHS[plan]);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}
function digestCode(code) {
  const pepper = String(process.env.JAZZ_DISCOUNT_CODE_PEPPER || "");
  if (!pepper) throw Object.assign(new Error("Discount-code service is not configured on the server."), { status: 503 });
  return crypto.createHmac("sha256", pepper).update(String(code || "").trim().toUpperCase()).digest("hex");
}
function codeIsValid(row, now = Date.now()) {
  return Boolean(row && row.active && new Date(row.starts_at).getTime() <= now &&
    (!row.expires_at || new Date(row.expires_at).getTime() > now) &&
    (row.max_redemptions == null || Number(row.redeemed_count) < Number(row.max_redemptions)) &&
    ALLOWED_DISCOUNTS.has(Number(row.percent_off)));
}
function trialEligible(row, trial) {
  if (!row?.trial_eligible_from && !row?.trial_eligible_until) return true;
  if (!trial?.starts_at) return false;
  const started = new Date(trial.starts_at).getTime();
  return (!row.trial_eligible_from || started >= new Date(row.trial_eligible_from).getTime()) &&
    (!row.trial_eligible_until || started <= new Date(row.trial_eligible_until).getTime());
}
function codeEligibleForPlan(row, plan) { return Boolean(row && String(row.eligible_plan || "annual") === plan && plan === "annual"); }
export function discountedPrice(percent, plan = "annual") {
  if (!ALLOWED_DISCOUNTS.has(percent)) throw new Error("Discount must be 10%, 20% or 50%.");
  if (normalizePlan(plan) !== "annual") throw new Error("Discount codes apply only to the annual plan.");
  return Math.round(PLAN_PRICES_PAISE.annual * (100 - percent) / 100);
}
function reply(req, res, status, body, json) { json(req, res, status, body); return true; }
async function adminCheck(userId, db) {
  return Boolean(await db.prepare("SELECT user_id FROM billing_admins WHERE user_id=?").get(userId));
}
async function audit(db, actorId, action, details = {}) {
  await db.prepare("INSERT INTO billing_audit(actor_user_id,action,details) VALUES(?,?,?)")
    .run(actorId ?? null, action, JSON.stringify(details));
}
function trialClaimHash(username) {
  const normalized = String(username || "").trim().toLowerCase();
  const pepper = String(process.env.JAZZ_TRIAL_CLAIM_PEPPER || "");
  return pepper
    ? crypto.createHmac("sha256", pepper).update(normalized).digest("hex")
    : crypto.createHash("sha256").update(normalized).digest("hex");
}
function makeCode() { return "JAZZ-" + crypto.randomBytes(6).toString("hex").toUpperCase(); }
async function jsonBody(req, readJson) { return await readJson(req, 64 * 1024); }
async function userTrial(db, userId) {
  return await db.prepare("SELECT starts_at,expires_at FROM billing_trials WHERE user_id=?").get(userId);
}
export async function getBillingAccess(db, userId) {
  const [trial, subscription, isBillingAdmin] = await Promise.all([
    userTrial(db, userId),
    db.prepare("SELECT id,status,starts_at,expires_at,amount_paid_paise,plan_type FROM billing_subscriptions WHERE user_id=? AND status IN ('active','complimentary') AND starts_at<=CURRENT_TIMESTAMP AND expires_at>CURRENT_TIMESTAMP ORDER BY expires_at DESC LIMIT 1").get(userId),
    adminCheck(userId, db)
  ]);
  const now = Date.now();
  const subscribed = Boolean(subscription && ["active", "complimentary"].includes(subscription.status) && new Date(subscription.starts_at).getTime() <= now && new Date(subscription.expires_at).getTime() > now);
  const trialing = Boolean(trial && new Date(trial.starts_at).getTime() <= now && new Date(trial.expires_at).getTime() > now);
  const trialPending = Boolean(trial && new Date(trial.starts_at).getTime() > now);
  return { allowed: isBillingAdmin || subscribed || trialing, isBillingAdmin, trial, subscription, subscribed, trialing,
    access: isBillingAdmin || subscribed ? "subscribed" : trialing ? "trial" : trialPending ? "trial_pending" : "expired" };
}
async function findDiscount(code, db, userId) {
  const row = await db.prepare("SELECT * FROM billing_discount_codes WHERE code_hash=?").get(digestCode(code));
  const trial = await userTrial(db, userId);
  if (!codeIsValid(row) || !codeEligibleForPlan(row, "annual") || !trialEligible(row, trial)) return null;
  const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").get(row.id, userId);
  if (Number(used?.total || 0) >= Number(row.per_user_limit || 1)) return null;
  return row;
}

export async function handleBillingRoute({ req, res, path, db, json, readJson, requireSession }) {
  if (!path.startsWith("/api/billing/")) return false;
  const session = await requireSession(req, res);
  if (!session) return true;
  const userId = session.user_id;


  if (req.method === "GET" && path === "/api/billing/status") {
    const access = await getBillingAccess(db, userId);
    const [latestSubscription, pending] = await Promise.all([
      db.prepare("SELECT id,status,starts_at,expires_at,amount_paid_paise,plan_type FROM billing_subscriptions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(userId),
      db.prepare("SELECT id,plan_type,amount_paise,status,created_at FROM billing_payment_intents WHERE user_id=? AND status IN ('pending','awaiting_dynamic_checkout') ORDER BY created_at DESC LIMIT 1").get(userId)
    ]);
    const paid = access.subscribed;
    const trialing = access.trialing;
    return reply(req, res, 200, {
      ok: true, plans: PLAN_PRICES_PAISE, planDetails: PLAN_CONFIG, paymentLinks: PAYMENT_LINKS,
      trial: access.trial ? { startsAt: access.trial.starts_at, expiresAt: access.trial.expires_at, active: trialing } : null,
      subscription: latestSubscription ? { ...latestSubscription, active: Boolean(access.subscription && latestSubscription.id === access.subscription.id) } : null,
      pendingPayment: pending || null,
      access: access.access,
      canUsePaidFeatures: access.allowed,
      isBillingAdmin: access.isBillingAdmin
    }, json);
  }

  if (req.method === "POST" && path === "/api/billing/discount/validate") {
    const body = await jsonBody(req, readJson);
    if (String(body.plan || "annual").toLowerCase() !== "annual") return reply(req, res, 200, { ok: true, valid: false, error: "Discount codes apply only to the annual plan." }, json);
    try {
      const row = await findDiscount(body.code, db, userId);
      if (!row) return reply(req, res, 200, { ok: true, valid: false, error: "This discount code is invalid, expired, disabled, or not eligible for this account." }, json);
      return reply(req, res, 200, { ok: true, valid: true, percentOff: Number(row.percent_off), amountPaise: discountedPrice(Number(row.percent_off)), originalAmountPaise: PLAN_PRICES_PAISE.annual, plan: "annual", label: row.label }, json);
    } catch (error) { return reply(req, res, error.status || 503, { ok: false, error: error.message || "Could not validate discount code." }, json); }
  }

  if (req.method === "POST" && path === "/api/billing/checkout") {
    const body = await jsonBody(req, readJson);
    let plan;
    try { plan = normalizePlan(body.plan); }
    catch (error) { return reply(req, res, error.status || 400, { ok: false, error: error.message }, json); }
    const status = await db.prepare("SELECT id FROM billing_subscriptions WHERE user_id=? AND status IN ('active','complimentary') AND starts_at<=CURRENT_TIMESTAMP AND expires_at>CURRENT_TIMESTAMP LIMIT 1").get(userId);
    if (status) {
      return reply(req, res, 409, { ok: false, error: "Your subscription is already active." }, json);
    }
    let discount = null;
    if (String(body.code || "").trim()) {
      if (plan !== "annual") return reply(req, res, 400, { ok: false, error: "Discount codes apply only to the annual plan." }, json);
      try { discount = await findDiscount(body.code, db, userId); }
      catch (error) { return reply(req, res, error.status || 503, { ok: false, error: error.message }, json); }
      if (!discount) return reply(req, res, 409, { ok: false, error: "This discount code is invalid, expired, disabled, or not eligible." }, json);
    }
    const amountPaise = discount ? discountedPrice(Number(discount.percent_off)) : PLAN_PRICES_PAISE[plan];
    const intentId = crypto.randomUUID();
    const paymentUrl = discount ? null : PAYMENT_LINKS[plan];
    const intentStatus = discount ? "awaiting_dynamic_checkout" : "pending";
    try {
      await db.transaction(async () => {
        await db.prepare("UPDATE billing_payment_intents SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND status IN ('pending','awaiting_dynamic_checkout')").run(userId);
        if (discount) {
          const locked = await db.prepare("SELECT * FROM billing_discount_codes WHERE id=? FOR UPDATE").get(discount.id);
          const trial = await userTrial(db, userId);
          if (!codeIsValid(locked) || !codeEligibleForPlan(locked, plan) || !trialEligible(locked, trial)) {
            throw Object.assign(new Error("This discount code is no longer available for this account."), { status: 409 });
          }
          const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").get(discount.id, userId);
          if (Number(used.total || 0) >= Number(locked.per_user_limit || 1)) throw Object.assign(new Error("This account has reached its per-account discount limit."), { status: 409 });
          const pending = await db.prepare("SELECT COUNT(*) AS total FROM billing_payment_intents WHERE discount_code_id=? AND status='awaiting_dynamic_checkout'").get(discount.id);
          if (locked.max_redemptions != null && Number(locked.redeemed_count) + Number(pending.total || 0) >= Number(locked.max_redemptions)) {
            throw Object.assign(new Error("This discount code has reached its redemption limit."), { status: 409 });
          }
        }
        await db.prepare("INSERT INTO billing_payment_intents(id,user_id,plan_type,amount_paise,discount_code_id,payment_url,status) VALUES(?,?,?,?,?,?,?)")
          .run(intentId, userId, plan, amountPaise, discount?.id || null, paymentUrl, intentStatus);
        await audit(db, userId, "PAYMENT_INTENT_CREATED", { intentId, plan, amountPaise, discounted: Boolean(discount) });
      });
    } catch (error) {
      return reply(req, res, error.status || (error.code === "23505" ? 409 : 500), { ok: false, error: error.message || "Could not create payment intent." }, json);
    }
    if (discount) return reply(req, res, 202, {
      ok: true, pending: true, intentId, plan, originalAmountPaise: PLAN_PRICES_PAISE.annual,
      amountPaise, percentOff: Number(discount.percent_off), paymentUrl: null,
      message: "Discount validated. This discounted amount requires dynamic Razorpay checkout; no payment has been collected and no subscription has been activated."
    }, json);
    return reply(req, res, 200, {
      ok: true, pending: true, intentId, plan, amountPaise, paymentUrl,
      message: "Continue to Razorpay. Access will remain pending until the server verifies payment."
    }, json);
  }

  if (path.startsWith("/api/billing/admin/")) {
    if (!(await adminCheck(userId, db))) return reply(req, res, 403, { ok: false, error: "Billing administrator access required." }, json);

    if (req.method === "GET" && path === "/api/billing/admin/discount-codes") {
      const rows = await db.prepare("SELECT id,label,percent_off,active,starts_at,expires_at,trial_eligible_from,trial_eligible_until,max_redemptions,redeemed_count,eligible_plan,per_user_limit,created_at,updated_at FROM billing_discount_codes ORDER BY created_at DESC").all();
      return reply(req, res, 200, { ok: true, items: rows }, json);
    }
    if (req.method === "POST" && path === "/api/billing/admin/discount-codes") {
      const body = await jsonBody(req, readJson);
      const percent = Number(body.percentOff);
      if (!ALLOWED_DISCOUNTS.has(percent)) return reply(req, res, 400, { ok: false, error: "Discount must be 10%, 20% or 50%." }, json);
      const code = String(body.code || makeCode()).trim().toUpperCase();
      if (!/^[A-Z0-9-]{5,40}$/.test(code)) return reply(req, res, 400, { ok: false, error: "Code must contain 5–40 letters, numbers or hyphens." }, json);
      const label = String(body.label || `${percent}% annual discount`).trim().slice(0, 100);
      const max = body.maxRedemptions == null || body.maxRedemptions === "" ? null : Number(body.maxRedemptions);
      if (max != null && (!Number.isInteger(max) || max < 1 || max > 1000000)) return reply(req, res, 400, { ok: false, error: "Redemption limit must be a positive whole number." }, json);
      let starts, expires, trialFrom, trialUntil;
      try {
        starts = parseDate(body.startsAt || new Date(), "Start date");
        expires = parseDate(body.expiresAt, "Expiry date", true);
        trialFrom = parseDate(body.trialEligibleFrom, "Trial eligibility start", true);
        trialUntil = parseDate(body.trialEligibleUntil, "Trial eligibility end", true);
      } catch (error) { return reply(req, res, error.status || 400, { ok: false, error: error.message }, json); }
      if ((expires && expires <= starts) || (trialFrom && trialUntil && trialUntil <= trialFrom)) return reply(req, res, 400, { ok: false, error: "Date ranges must end after they start." }, json);
      const perUserLimit = Number(body.perUserLimit || 1);
      if (!Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 1000000) return reply(req, res, 400, { ok: false, error: "Per-user limit must be a positive whole number." }, json);
      try {
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO billing_discount_codes(id,code_hash,label,percent_off,active,starts_at,expires_at,trial_eligible_from,trial_eligible_until,max_redemptions,eligible_plan,per_user_limit,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, digestCode(code), label, percent, body.active !== false, starts, expires, trialFrom, trialUntil, max, "annual", perUserLimit, userId);
        await audit(db, userId, "DISCOUNT_CREATED", { id, label, percentOff: percent });
        return reply(req, res, 201, { ok: true, id, code, label, percentOff: percent }, json);
      } catch (error) { return reply(req, res, error?.code === "23505" ? 409 : error.status || 500, { ok: false, error: error?.code === "23505" ? "That code already exists." : error.message || "Could not create discount code." }, json); }
    }

    const codeAction = path.match(/^\/api\/billing\/admin\/discount-codes\/([a-f0-9-]+)\/(enable|disable|update|delete)$/i);
    if (req.method === "POST" && codeAction) {
      const [, id, action] = codeAction;
      const existing = await db.prepare("SELECT * FROM billing_discount_codes WHERE id=?").get(id);
      if (!existing) return reply(req, res, 404, { ok: false, error: "Discount code not found." }, json);
      if (action === "delete") {
        const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=?").get(id);
        if (Number(used.total) > 0) return reply(req, res, 409, { ok: false, error: "This code has redemption history and cannot be deleted. Disable it instead." }, json);
        await db.prepare("DELETE FROM billing_discount_codes WHERE id=?").run(id);
        await audit(db, userId, "DISCOUNT_DELETED", { id });
        return reply(req, res, 200, { ok: true }, json);
      }
      if (action === "enable" || action === "disable") {
        await db.prepare("UPDATE billing_discount_codes SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(action === "enable", id);
        await audit(db, userId, action === "enable" ? "DISCOUNT_ENABLED" : "DISCOUNT_DISABLED", { id });
        return reply(req, res, 200, { ok: true, active: action === "enable" }, json);
      }
      const body = await jsonBody(req, readJson);
      const percent = body.percentOff == null ? Number(existing.percent_off) : Number(body.percentOff);
      if (!ALLOWED_DISCOUNTS.has(percent)) return reply(req, res, 400, { ok: false, error: "Discount must be 10%, 20% or 50%." }, json);
      const label = body.label == null ? existing.label : String(body.label).trim().slice(0, 100);
      let starts, expires, trialFrom, trialUntil;
      try {
        starts = body.startsAt === undefined ? existing.starts_at : parseDate(body.startsAt, "Start date");
        expires = body.expiresAt === undefined ? existing.expires_at : parseDate(body.expiresAt, "Expiry date", true);
        trialFrom = body.trialEligibleFrom === undefined ? existing.trial_eligible_from : parseDate(body.trialEligibleFrom, "Trial eligibility start", true);
        trialUntil = body.trialEligibleUntil === undefined ? existing.trial_eligible_until : parseDate(body.trialEligibleUntil, "Trial eligibility end", true);
      } catch (error) { return reply(req, res, error.status || 400, { ok: false, error: error.message }, json); }
      const max = body.maxRedemptions === undefined ? existing.max_redemptions : (body.maxRedemptions === "" || body.maxRedemptions == null ? null : Number(body.maxRedemptions));
      const perUserLimit = body.perUserLimit === undefined ? Number(existing.per_user_limit || 1) : Number(body.perUserLimit);
      let codeHash = existing.code_hash;
      if (body.code != null && String(body.code).trim()) {
        const replacement = String(body.code).trim().toUpperCase();
        if (!/^[A-Z0-9-]{5,40}$/.test(replacement)) return reply(req, res, 400, { ok: false, error: "Replacement code must contain 5–40 letters, numbers or hyphens." }, json);
        codeHash = digestCode(replacement);
      }
      if ((expires && new Date(expires) <= new Date(starts)) || (trialFrom && trialUntil && new Date(trialUntil) <= new Date(trialFrom)) ||
          (max != null && (!Number.isInteger(max) || max < Number(existing.redeemed_count))) || !Number.isInteger(perUserLimit) || perUserLimit < 1) {
        return reply(req, res, 400, { ok: false, error: "Invalid date range or usage limit." }, json);
      }
      try {
        await db.prepare("UPDATE billing_discount_codes SET code_hash=?,label=?,percent_off=?,starts_at=?,expires_at=?,trial_eligible_from=?,trial_eligible_until=?,max_redemptions=?,per_user_limit=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(codeHash, label, percent, starts, expires, trialFrom, trialUntil, max, perUserLimit, id);
      } catch (error) { return reply(req, res, error?.code === "23505" ? 409 : error.status || 500, { ok: false, error: error?.code === "23505" ? "That replacement code already exists." : error.message || "Could not update discount code." }, json); }
      await audit(db, userId, "DISCOUNT_UPDATED", { id, percentOff: percent, codeRotated: codeHash !== existing.code_hash });
      return reply(req, res, 200, { ok: true, code: body.code ? String(body.code).trim().toUpperCase() : undefined }, json);
    }

    if (req.method === "GET" && path === "/api/billing/admin/user-ledger") {
      const rows = await db.prepare(`SELECT u.id AS user_id,u.username,t.starts_at AS trial_started_at,t.expires_at AS trial_ends_at,
        s.id AS subscription_id,s.plan_type AS subscription_plan,s.status AS subscription_status,
        s.starts_at AS subscription_started_at,s.expires_at AS subscription_ends_at,s.amount_paid_paise,
        (SELECT COUNT(*) FROM billing_payment_intents p WHERE p.user_id=u.id AND p.status IN ('pending','awaiting_dynamic_checkout')) AS pending_payments
        FROM users u LEFT JOIN billing_trials t ON t.user_id=u.id
        LEFT JOIN LATERAL (SELECT id,plan_type,status,starts_at,expires_at,amount_paid_paise FROM billing_subscriptions WHERE user_id=u.id ORDER BY created_at DESC,id DESC LIMIT 1) s ON TRUE
        ORDER BY LOWER(u.username) LIMIT 20000`).all();
      const now = Date.now();
      return reply(req, res, 200, { ok: true, items: rows.map(row => ({ ...row,
        trial_active: Boolean(row.trial_started_at && row.trial_ends_at && new Date(row.trial_started_at).getTime() <= now && new Date(row.trial_ends_at).getTime() > now),
        subscription_active: Boolean(row.subscription_started_at && row.subscription_ends_at && row.subscription_status === "active" && new Date(row.subscription_started_at).getTime() <= now && new Date(row.subscription_ends_at).getTime() > now)
      })) }, json);
    }
    if (req.method === "GET" && path === "/api/billing/admin/payment-intents") {
      const items = await db.prepare("SELECT p.id,p.user_id,u.username,p.plan_type,p.amount_paise,p.discount_code_id,p.payment_url,p.status,p.created_at FROM billing_payment_intents p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 500").all();
      return reply(req, res, 200, { ok: true, items }, json);
    }
    if (req.method === "GET" && path === "/api/billing/admin/subscriptions") {
      const items = await db.prepare("SELECT s.id,s.user_id,u.username,s.plan_type,s.status,s.starts_at,s.expires_at,s.amount_paid_paise,s.payment_id,s.created_at FROM billing_subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.created_at DESC LIMIT 1000").all();
      return reply(req, res, 200, { ok: true, items }, json);
    }
    if (req.method === "GET" && path === "/api/billing/admin/payments") {
      const items = await db.prepare("SELECT p.id,p.user_id,u.username,p.order_id,p.payment_id,p.plan_type,p.amount_paise,p.status,p.created_at,p.updated_at FROM billing_payments p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 1000").all();
      return reply(req, res, 200, { ok: true, items }, json);
    }
    const usageMatch = path.match(/^\/api\/billing\/admin\/discount-codes\/([a-f0-9-]+)\/usage$/i);
    if (req.method === "GET" && usageMatch) {
      const items = await db.prepare("SELECT r.id,r.user_id,u.username,r.subscription_id,r.amount_paid_paise,r.created_at FROM billing_discount_redemptions r JOIN users u ON u.id=r.user_id WHERE r.discount_code_id=? ORDER BY r.created_at DESC LIMIT 1000").all(usageMatch[1]);
      return reply(req, res, 200, { ok: true, items }, json);
    }
    const trialAction = path.match(/^\/api\/billing\/admin\/users\/(\d+)\/trial$/);
    if (req.method === "POST" && trialAction) {
      const targetId = Number(trialAction[1]);
      const body = await jsonBody(req, readJson);
      let starts, expires;
      try { starts = parseDate(body.startsAt, "Trial start"); expires = parseDate(body.expiresAt, "Trial expiry"); }
      catch (error) { return reply(req, res, error.status || 400, { ok: false, error: error.message }, json); }
      if (new Date(expires) <= new Date(starts)) return reply(req, res, 400, { ok: false, error: "Trial expiry must be after trial start." }, json);
      const before = await userTrial(db, targetId);
      const target = await db.prepare("SELECT id,username FROM users WHERE id=?").get(targetId);
      if (!target) return reply(req, res, 404, { ok: false, error: "User not found." }, json);
      await db.prepare("INSERT INTO billing_trials(user_id,starts_at,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET starts_at=EXCLUDED.starts_at,expires_at=EXCLUDED.expires_at")
        .run(targetId, starts, expires);
      await audit(db, userId, "TRIAL_UPDATED", { targetUserId: targetId, before: before || null, after: { startsAt: starts, expiresAt: expires } });
      return reply(req, res, 200, { ok: true }, json);
    }
    const subscriptionAction = path.match(/^\/api\/billing\/admin\/users\/(\d+)\/subscription$/);
    if (req.method === "POST" && subscriptionAction) {
      const targetId = Number(subscriptionAction[1]);
      const body = await jsonBody(req, readJson);
      const target = await db.prepare("SELECT id FROM users WHERE id=?").get(targetId);
      if (!target) return reply(req, res, 404, { ok: false, error: "User not found." }, json);
      const existing = await db.prepare("SELECT id,status,starts_at,expires_at,plan_type,amount_paid_paise FROM billing_subscriptions WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 1").get(targetId);
      if (!existing) return reply(req, res, 404, { ok: false, error: "No subscription record exists for this user." }, json);
      const status = String(body.status || existing.status);
      if (!['active', 'expired', 'refunded'].includes(status)) return reply(req, res, 400, { ok: false, error: "Status must be active, expired or refunded." }, json);
      let starts, expires, plan;
      try {
        starts = body.startsAt === undefined ? existing.starts_at : parseDate(body.startsAt, "Subscription start");
        expires = body.expiresAt === undefined ? existing.expires_at : parseDate(body.expiresAt, "Subscription expiry");
        plan = body.planType === undefined ? existing.plan_type : normalizePlan(body.planType);
      } catch (error) { return reply(req, res, error.status || 400, { ok: false, error: error.message }, json); }
      if (new Date(expires) <= new Date(starts)) return reply(req, res, 400, { ok: false, error: "Subscription expiry must be after its start." }, json);
      await db.prepare("UPDATE billing_subscriptions SET status=?,starts_at=?,expires_at=?,plan_type=? WHERE id=?")
        .run(status, starts, expires, plan, existing.id);
      await audit(db, userId, "SUBSCRIPTION_UPDATED", { targetUserId: targetId, before: existing, after: { status, startsAt: starts, expiresAt: expires, planType: plan } });
      return reply(req, res, 200, { ok: true }, json);
    }
    const deleteAction = path.match(/^\/api\/billing\/admin\/users\/(\d+)\/delete$/);
    if (req.method === "POST" && deleteAction) {
      const targetId = Number(deleteAction[1]);
      const body = await jsonBody(req, readJson);
      const target = await db.prepare("SELECT id,username FROM users WHERE id=?").get(targetId);
      if (!target) return reply(req, res, 404, { ok: false, error: "User not found." }, json);
      if (targetId === userId) return reply(req, res, 409, { ok: false, error: "You cannot delete your own billing administrator account." }, json);
      const protectedAdmin = await db.prepare("SELECT user_id FROM billing_admins WHERE user_id=?").get(targetId);
      if (protectedAdmin) return reply(req, res, 403, { ok: false, error: "Billing administrator accounts are protected from this operation." }, json);
      if (String(body.confirmUsername || "") !== target.username) return reply(req, res, 400, { ok: false, error: "Type the exact username to confirm permanent deletion." }, json);
      await db.transaction(async () => {
        const usernameHash = trialClaimHash(target.username);
        // A username claim belongs to this account identity. Remove it explicitly
        // before deleting the user so a deliberate admin deletion permits a fresh
        // registration/trial for the same username. Keep both operations atomic.
        const removedClaim = await db.prepare("DELETE FROM billing_trial_claims WHERE username_hash=? OR user_id=? RETURNING username_hash")
          .get(usernameHash, targetId);
        await audit(db, userId, "USER_PERMANENTLY_DELETED", {
          targetUserId: targetId,
          usernameHash,
          trialClaimRemoved: Boolean(removedClaim)
        });
        await db.prepare("DELETE FROM users WHERE id=?").run(targetId);
      });
      return reply(req, res, 200, { ok: true }, json);
    }
    if (req.method === "GET" && path === "/api/billing/admin/audit") {
      const items = await db.prepare("SELECT id,actor_user_id,action,details,created_at FROM billing_audit ORDER BY created_at DESC LIMIT 500").all();
      return reply(req, res, 200, { ok: true, items }, json);
    }
  }
  return reply(req, res, 404, { ok: false, error: "Billing endpoint not found." }, json);
}
