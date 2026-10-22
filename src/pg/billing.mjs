import crypto from "node:crypto";

const ANNUAL_PRICE_PAISE = 49900;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const ALLOWED_DISCOUNTS = new Set([10, 20, 50, 100]);

function codeDigest(code) {
  const pepper = String(process.env.JAZZ_DISCOUNT_PEPPER || process.env.RAZORPAY_KEY_SECRET || "").trim();
  if (!pepper) throw new Error("JAZZ_DISCOUNT_PEPPER must be configured before discount codes can be used.");
  return crypto.createHmac("sha256", pepper).update(String(code).trim().toUpperCase()).digest("hex");
}
function safeCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{3,39}$/.test(code) ? code : "";
}
function ownerAllowed(session) {
  const owner = String(process.env.JAZZ_OWNER_USERNAME || "").trim().toLowerCase();
  return Boolean(owner && session?.username && String(session.username).toLowerCase() === owner);
}
function json(req, res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(JSON.stringify(body));
}
function rawBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => { size += chunk.length; if (size > limit) { reject(new Error("Webhook body too large")); req.destroy(); } else chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function equalHex(a, b) {
  try {
    const left = Buffer.from(String(a || ""), "hex"), right = Buffer.from(String(b || ""), "hex");
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
  } catch { return false; }
}
function currentSubscription(row) {
  const now = Date.now();
  if (!row) return { status: "none", access: false, trialEndsAt: null, paidEndsAt: null };
  const trialEnd = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
  const paidEnd = row.paid_ends_at ? new Date(row.paid_ends_at).getTime() : 0;
  if ((row.status === "active" || row.status === "complimentary") && paidEnd > now) {
    return { status: row.status, access: true, trialEndsAt: row.trial_ends_at, paidEndsAt: row.paid_ends_at };
  }
  if (trialEnd > now) return { status: "trialing", access: true, trialEndsAt: row.trial_ends_at, paidEndsAt: row.paid_ends_at };
  return { status: "expired", access: false, trialEndsAt: row.trial_ends_at, paidEndsAt: row.paid_ends_at };
}
export async function startTrialForUser(db, userId) {
  const now = Date.now();
  await db.prepare("INSERT INTO subscriptions(user_id,trial_started_at,trial_ends_at,status) VALUES(?,?,?,'trialing') ON CONFLICT(user_id) DO NOTHING")
    .run(userId, new Date(now).toISOString(), new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString());
}
async function razorpayRequest(path, body) {
  const key = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const secret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  if (!key || !secret) throw Object.assign(new Error("Payments are not configured yet. Please try again later."), { status: 503 });
  const response = await fetch("https://api.razorpay.com/v1" + path, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(key + ":" + secret).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error("Payment provider could not create the order."), { status: 502 });
  return data;
}
async function subscriptionFor(db, userId) {
  return await db.prepare("SELECT * FROM subscriptions WHERE user_id=?").get(userId);
}
async function validateDiscount(db, codeRaw, userId) {
  const code = safeCode(codeRaw);
  if (!code) return { error: "Enter a valid discount code." };
  const row = await db.prepare("SELECT * FROM discount_codes WHERE code_hash=?").get(codeDigest(code));
  if (!row || !row.active || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) ||
      (row.max_redemptions != null && Number(row.redemption_count) >= Number(row.max_redemptions))) {
    return { error: "This discount code is invalid, expired, disabled, or fully redeemed." };
  }
  const prior = await db.prepare("SELECT id FROM discount_redemptions WHERE discount_code_id=? AND user_id=?").get(row.id, userId);
  if (prior) return { error: "This account has already used this discount code." };
  return { row, amountPaise: Math.round(ANNUAL_PRICE_PAISE * (100 - Number(row.percent_off)) / 100) };
}
async function grantAnnual(db, { userId, orderId = null, paymentId = null, complimentary = false, discount = null, amountPaise = ANNUAL_PRICE_PAISE }) {
  return await db.transaction(async () => {
    const existing = await db.prepare("SELECT * FROM subscriptions WHERE user_id=? FOR UPDATE").get(userId);
    if (!existing) throw new Error("Subscription record missing");
    if (paymentId && await db.prepare("SELECT user_id FROM subscriptions WHERE last_payment_id=?").get(paymentId)) return;
    if (discount && complimentary) {
      const lockedDiscount = await db.prepare("SELECT * FROM discount_codes WHERE id=? FOR UPDATE").get(discount.id);
      if (!lockedDiscount || !lockedDiscount.active ||
          (lockedDiscount.expires_at && new Date(lockedDiscount.expires_at).getTime() <= Date.now()) ||
          (lockedDiscount.max_redemptions != null && Number(lockedDiscount.redemption_count) >= Number(lockedDiscount.max_redemptions))) {
        throw Object.assign(new Error("This complimentary code is no longer available."), { status: 409 });
      }
      const alreadyRedeemed = await db.prepare("SELECT id FROM discount_redemptions WHERE discount_code_id=? AND user_id=?").get(discount.id, userId);
      if (alreadyRedeemed) return;
    }
    const now = Date.now();
    const oldEnd = existing.paid_ends_at ? new Date(existing.paid_ends_at).getTime() : 0;
    const start = oldEnd > now ? oldEnd : now;
    const end = start + YEAR_MS;
    await db.prepare("UPDATE subscriptions SET paid_started_at=?,paid_ends_at=?,status=?,last_payment_id=?,last_order_id=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?")
      .run(new Date(start).toISOString(), new Date(end).toISOString(), complimentary ? "complimentary" : "active", paymentId, orderId, userId);
    await db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,NULL,?,?)")
      .run(userId, complimentary ? "COMPLIMENTARY_ANNUAL" : "SUBSCRIPTION_ANNUAL_GRANTED", complimentary ? "SUCCESS" : "PAYMENT_VERIFIED");
    if (discount) {
      const redemption = await db.prepare("INSERT INTO discount_redemptions(discount_code_id,user_id,subscription_id,percent_off,amount_paise) VALUES(?,?,?,?,?) ON CONFLICT(discount_code_id,user_id) DO NOTHING")
        .run(discount.id, userId, existing.id, discount.percent_off, amountPaise);
      if (redemption.changes) await db.prepare("UPDATE discount_codes SET redemption_count=redemption_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(discount.id);
    }
  });
}
async function handleWebhook(req, res, { db, json: sendJson }) {
  const send = sendJson || json;
  const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
  if (!secret) return send(req, res, 503, { ok: false, error: "Webhook is not configured" });
  const body = await rawBody(req);
  const supplied = String(req.headers["x-razorpay-signature"] || "");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (!equalHex(supplied, expected)) return send(req, res, 401, { ok: false, error: "Invalid webhook signature" });
  const event = JSON.parse(body.toString("utf8"));
  const eventId = String(req.headers["x-razorpay-event-id"] || "").trim();
  if (!eventId || !event.event) return send(req, res, 400, { ok: false, error: "Missing webhook event ID" });
  if (event.event !== "payment.captured") {
    await db.prepare("INSERT INTO payment_webhook_events(event_id,event_type) VALUES(?,?) ON CONFLICT(event_id) DO NOTHING").run(eventId, event.event);
    return send(req, res, 200, { ok: true, ignored: true });
  }
  const payment = event.payload?.payment?.entity;
  const order = event.payload?.order?.entity;
  const orderId = String(payment?.order_id || order?.id || "");
  const paymentId = String(payment?.id || "");
  if (!orderId || !paymentId || payment?.status !== "captured") return send(req, res, 400, { ok: false, error: "Payment is not captured" });
  const priorEvent = await db.prepare("SELECT event_id FROM payment_webhook_events WHERE event_id=?").get(eventId);
  if (priorEvent) return send(req, res, 200, { ok: true, duplicate: true });
  const attempt = await db.prepare("SELECT * FROM payment_orders WHERE provider_order_id=?").get(orderId);
  if (!attempt || Number(payment.amount) !== Number(attempt.amount_paise) || String(payment.currency) !== "INR") {
    return send(req, res, 400, { ok: false, error: "Payment does not match the expected order" });
  }
  await grantAnnual(db, { userId: attempt.user_id, orderId, paymentId, discount: attempt.discount_code_id ? await db.prepare("SELECT * FROM discount_codes WHERE id=?").get(attempt.discount_code_id) : null, amountPaise: attempt.amount_paise });
  await db.transaction(async () => {
    await db.prepare("INSERT INTO payment_webhook_events(event_id,event_type) VALUES(?,?) ON CONFLICT(event_id) DO NOTHING").run(eventId, event.event);
    await db.prepare("UPDATE payment_orders SET status='paid',paid_at=CURRENT_TIMESTAMP WHERE provider_order_id=? AND status='created'").run(orderId);
  });
  return send(req, res, 200, { ok: true });
}
export async function handleBillingRequest(req, res, path, helpers) {
  const { db, readJson, requireSession } = helpers;
  const send = helpers.json || json;
  if (req.method === "POST" && path === "/api/billing/webhook") return await handleWebhook(req, res, { db, json: send }), true;
  if (!path.startsWith("/api/billing/") && !path.startsWith("/api/admin/discount-codes")) return false;
  const session = await requireSession(req, res);
  if (!session) return true;
  try {
    if (req.method === "GET" && path === "/api/billing/status") {
      const sub = await subscriptionFor(db, session.user_id);
      return send(req, res, 200, { ok: true, pricePaise: ANNUAL_PRICE_PAISE, subscription: currentSubscription(sub) }), true;
    }
    if (req.method === "POST" && path === "/api/billing/discount/validate") {
      const body = await readJson(req, 16 * 1024);
      const result = await validateDiscount(db, body.code, session.user_id);
      if (result.error) return send(req, res, 400, { ok: false, error: result.error }), true;
      return send(req, res, 200, { ok: true, percentOff: result.row.percent_off, amountPaise: result.amountPaise }), true;
    }
    if (req.method === "POST" && path === "/api/billing/checkout") {
      const body = await readJson(req, 16 * 1024);
      const sub = await subscriptionFor(db, session.user_id);
      const state = currentSubscription(sub);
      if (state.access && state.status !== "trialing") return send(req, res, 409, { ok: false, error: "An annual subscription is already active." }), true;
      let discount = null, amountPaise = ANNUAL_PRICE_PAISE;
      if (body.code) {
        const result = await validateDiscount(db, body.code, session.user_id);
        if (result.error) return send(req, res, 400, { ok: false, error: result.error }), true;
        discount = result.row; amountPaise = result.amountPaise;
      }
      if (amountPaise === 0 && discount?.percent_off === 100) {
        await grantAnnual(db, { userId: session.user_id, complimentary: true, discount, amountPaise: 0 });
        return send(req, res, 200, { ok: true, complimentary: true, subscription: currentSubscription(await subscriptionFor(db, session.user_id)) }), true;
      }
      const order = await razorpayRequest("/orders", { amount: amountPaise, currency: "INR", receipt: "jazz-" + crypto.randomUUID(), notes: { user_id: String(session.user_id), discount_code_id: discount ? String(discount.id) : "" } });
      await db.prepare("INSERT INTO payment_orders(user_id,discount_code_id,provider_order_id,amount_paise) VALUES(?,?,?,?)")
        .run(session.user_id, discount?.id ?? null, order.id, amountPaise);
      return send(req, res, 200, { ok: true, keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amountPaise, currency: "INR", description: "Jazz Recovery annual subscription" }), true;
    }
    if (path.startsWith("/api/admin/discount-codes")) {
      if (!ownerAllowed(session)) return send(req, res, 403, { ok: false, error: "Owner authorization required." }), true;
      if (req.method === "GET") {
        const rows = await db.prepare("SELECT id,code_hint,percent_off,active,expires_at,max_redemptions,redemption_count,created_at,updated_at FROM discount_codes ORDER BY created_at DESC LIMIT 200").all();
        return send(req, res, 200, { ok: true, items: rows }), true;
      }
      if (req.method === "POST") {
        const body = await readJson(req, 16 * 1024);
        const code = safeCode(body.code);
        const percent = Number(body.percentOff);
        if (!code || !ALLOWED_DISCOUNTS.has(percent)) return send(req, res, 400, { ok: false, error: "Use a valid code and a 10%, 20%, 50%, or 100% discount." }), true;
        const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
        const max = body.maxRedemptions == null || body.maxRedemptions === "" ? null : Number(body.maxRedemptions);
        if (expiresAt && !Number.isFinite(expiresAt.getTime())) return send(req, res, 400, { ok: false, error: "Invalid expiry date." }), true;
        if (max != null && (!Number.isInteger(max) || max < 1 || max > 1000000)) return send(req, res, 400, { ok: false, error: "Invalid redemption limit." }), true;
        try {
          await db.prepare("INSERT INTO discount_codes(code_hash,code_hint,percent_off,expires_at,max_redemptions,created_by) VALUES(?,?,?,?,?,?)")
            .run(codeDigest(code), code.slice(-4), percent, expiresAt?.toISOString() ?? null, max, session.username);
        } catch (error) {
          if (error?.code === "23505") return send(req, res, 409, { ok: false, error: "That code already exists. Disable it before creating a replacement." }), true;
          throw error;
        }
        await db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,NULL,'DISCOUNT_CREATE',?)").run(session.user_id, percent + "%");
        return send(req, res, 201, { ok: true, message: "Discount code created. Save the code securely; it is not stored in readable form." }), true;
      }
      const match = path.match(/^\/api\/admin\/discount-codes\/(\d+)$/);
      if (req.method === "PATCH" && match) {
        const body = await readJson(req, 16 * 1024);
        const id = Number(match[1]);
        const current = await db.prepare("SELECT * FROM discount_codes WHERE id=?").get(id);
        if (!current) return send(req, res, 404, { ok: false, error: "Discount code not found." }), true;
        const active = body.active === undefined ? current.active : body.active;
        const percent = body.percentOff === undefined ? Number(current.percent_off) : Number(body.percentOff);
        const expiresAt = body.expiresAt === undefined ? current.expires_at : (body.expiresAt ? new Date(body.expiresAt) : null);
        const max = body.maxRedemptions === undefined ? current.max_redemptions : (body.maxRedemptions == null || body.maxRedemptions === "" ? null : Number(body.maxRedemptions));
        if (typeof active !== "boolean" || !ALLOWED_DISCOUNTS.has(percent)) return send(req, res, 400, { ok: false, error: "Invalid active flag or discount percentage." }), true;
        if (expiresAt && (!(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime()))) return send(req, res, 400, { ok: false, error: "Invalid expiry date." }), true;
        if (max != null && (!Number.isInteger(max) || max < Number(current.redemption_count) || max > 1000000)) return send(req, res, 400, { ok: false, error: "Redemption limit cannot be below the number already used." }), true;
        const result = await db.prepare("UPDATE discount_codes SET active=?,percent_off=?,expires_at=?,max_redemptions=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
          .run(active, percent, expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt, max, id);
        await db.prepare("INSERT INTO recovery_audit(user_id,device_id,action,status) VALUES(?,NULL,'DISCOUNT_EDIT',?)").run(session.user_id, String(id));
        return send(req, res, result.changes ? 200 : 404, { ok: Boolean(result.changes) }), true;
      }
    }
    return send(req, res, 404, { ok: false, error: "Not found" }), true;
  } catch (error) {
    const status = Number(error?.status) || 500;
    if (status >= 500) console.error("[Jazz Billing] " + (error instanceof Error ? error.message : String(error)));
    return send(req, res, status, { ok: false, error: status < 500 ? error.message : "Billing service error" }), true;
  }
}
