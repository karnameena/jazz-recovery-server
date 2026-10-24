import crypto from "node:crypto";

export const PLAN_PRICES_PAISE = Object.freeze({ monthly: 4900, annual: 39900 });
function normalizePlan(value) {
  const plan = String(value || "annual").toLowerCase();
  if (!Object.hasOwn(PLAN_PRICES_PAISE, plan)) throw Object.assign(new Error("Choose a valid subscription plan."), { status: 400 });
  return plan;
}
export function planExpiry(startMs, plan) {
  plan = normalizePlan(plan);
  const start = new Date(startMs);
  const target = new Date(startMs);
  const day = start.getUTCDate();
  target.setUTCDate(1);
  if (plan === "monthly") target.setUTCMonth(target.getUTCMonth() + 1);
  else target.setUTCFullYear(target.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

function digestCode(code) {
  const pepper = String(process.env.JAZZ_DISCOUNT_CODE_PEPPER || "");
  if (!pepper) throw Object.assign(new Error("Discount-code service is not configured"), { status: 503 });
  return crypto.createHmac("sha256", pepper).update(String(code).trim().toUpperCase()).digest("hex");
}
function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function codeIsValid(row, now = Date.now()) {
  return Boolean(row && row.active && new Date(row.starts_at).getTime() <= now &&
    (!row.expires_at || new Date(row.expires_at).getTime() > now) &&
    (row.max_redemptions == null || Number(row.redeemed_count) < Number(row.max_redemptions)));
}
function codeEligibleForPlan(row, plan) {
  return Boolean(row && ["both", plan].includes(String(row.eligible_plan || "annual")));
}
export function discountedPrice(percent, plan = "annual") {
  if (!Number.isInteger(percent) || ![10,20,50,100].includes(percent)) throw new Error("Unsupported discount percentage");
  return Math.round(PLAN_PRICES_PAISE[normalizePlan(plan)] * (100 - percent) / 100);
}
function reply(req, res, status, body, json) { json(req, res, status, body); return true; }
async function sessionFor(req, res, json, requireSession) { return await requireSession(req, res); }
async function readRaw(req, maxBytes = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", chunk => { size += chunk.length; if (size > maxBytes) { reject(Object.assign(new Error("Request too large"), { status: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function adminCheck(userId, db) {
  return Boolean(await db.prepare("SELECT user_id FROM billing_admins WHERE user_id=?").get(userId));
}
async function audit(db, actorId, action, details = {}) {
  await db.prepare("INSERT INTO billing_audit(actor_user_id,action,details) VALUES(?,?,?)")
    .run(actorId ?? null, action, JSON.stringify(details));
}
function makeCode() { return "JAZZ-" + crypto.randomBytes(6).toString("hex").toUpperCase(); }

export async function ensureDefaultDiscountCodes(db) {
  const pepper = String(process.env.JAZZ_DISCOUNT_CODE_PEPPER || "");
  if (!pepper) return { seeded: false, reason: "discount pepper not configured" };
  const defaults = [
    { code: "jazzry10", label: "jazzry10 · 10% off annual", percent: 10, active: true },
    // Complimentary codes are created disabled until the owner sets a redemption limit.
    { code: "jazzfamly", label: "jazzfamly · complimentary annual", percent: 100, active: false }
  ];
  for (const item of defaults) {
    const hash = crypto.createHmac("sha256", pepper).update(item.code.toUpperCase()).digest("hex");
    await db.prepare("INSERT INTO billing_discount_codes(id,code_hash,label,percent_off,active) VALUES(?,?,?,?,?) ON CONFLICT(code_hash) DO NOTHING")
      .run(crypto.randomUUID(), hash, item.label, item.percent, item.active);
  }
  return { seeded: true };
}
async function getCode(code, db) {
  return await db.prepare("SELECT * FROM billing_discount_codes WHERE code_hash=?").get(digestCode(code));
}
async function redeemCode(db, row, userId, subscriptionId, amount, { enforceCurrentValidity = true } = {}) {
  const locked = await db.prepare("SELECT * FROM billing_discount_codes WHERE id=? FOR UPDATE").get(row.id);
  if (!locked || (enforceCurrentValidity && !codeIsValid(locked)) ||
      (!enforceCurrentValidity && locked.max_redemptions != null && Number(locked.redeemed_count) >= Number(locked.max_redemptions))) {
    throw Object.assign(new Error("This discount code is no longer available."), { status: 409 });
  }
  const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").get(row.id, userId);
  if (Number(used?.total || 0) >= Number(locked.per_user_limit || 1)) throw Object.assign(new Error("This account has reached this discount code's per-user redemption limit."), { status: 409 });
  await db.prepare("INSERT INTO billing_discount_redemptions(id,discount_code_id,user_id,subscription_id,amount_paid_paise) VALUES(?,?,?,?,?)")
    .run(crypto.randomUUID(), row.id, userId, subscriptionId, amount);
  await db.prepare("UPDATE billing_discount_codes SET redeemed_count=redeemed_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id);
}
async function grantSubscription(db, userId, amount, discountId, paymentId, plan = "annual", complimentary = false) {
  const current = await db.prepare("SELECT expires_at FROM billing_subscriptions WHERE user_id=? AND status IN ('active','complimentary') AND expires_at>CURRENT_TIMESTAMP ORDER BY expires_at DESC LIMIT 1").get(userId);
  const now = Date.now();
  const starts = current ? Math.max(now, new Date(current.expires_at).getTime()) : now;
  const subscriptionId = crypto.randomUUID();
  const status = complimentary ? "complimentary" : "active";
  const expires = planExpiry(starts, plan).toISOString();
  await db.prepare("INSERT INTO billing_subscriptions(id,user_id,status,starts_at,expires_at,amount_paid_paise,discount_code_id,payment_id,plan_type) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(subscriptionId, userId, status, new Date(starts).toISOString(), expires, amount, discountId, paymentId, plan);
  return { id: subscriptionId, status, expiresAt: expires };
}
async function jsonBody(req, readJson) { return await readJson(req, 64 * 1024); }

export async function handleBillingRoute({ req, res, path, db, json, readJson, requireSession }) {
  if (!path.startsWith("/api/billing/")) return false;
  if (req.method === "POST" && path === "/api/billing/razorpay/webhook") {
    const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "");
    if (!secret) return reply(req,res,503,{ok:false,error:"Payment webhook is not configured"},json);
    let raw;
    try { raw = await readRaw(req, 1024 * 1024); } catch (error) { return reply(req,res,error.status || 400,{ok:false,error:"Invalid webhook body"},json); }
    const supplied = String(req.headers["x-razorpay-signature"] || "");
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (!safeEqual(supplied, expected)) return reply(req,res,400,{ok:false,error:"Invalid webhook signature"},json);
    let event;
    try { event = JSON.parse(raw.toString("utf8")); } catch { return reply(req,res,400,{ok:false,error:"Invalid webhook JSON"},json); }
    const eventType = String(event.event || "unknown");
    const eventId = String(req.headers["x-razorpay-event-id"] || crypto.createHash("sha256").update(raw).digest("hex"));
    try {
      await db.transaction(async () => {
        const inserted = await db.prepare("INSERT INTO billing_webhook_events(event_id,event_type) VALUES(?,?) ON CONFLICT DO NOTHING RETURNING event_id").get(eventId,eventType);
        if (!inserted) return;
        if (!["payment.captured","order.paid"].includes(eventType)) return;
        const payment = event.payload?.payment?.entity;
        const order = event.payload?.order?.entity;
        const orderId = String(payment?.order_id || order?.id || "");
        const paymentId = String(payment?.id || "");
        const amount = Number(payment?.amount ?? order?.amount);
        if (!orderId || !paymentId || !Number.isSafeInteger(amount) || amount < 1 || (payment?.status && payment.status !== "captured")) return;
        const row = await db.prepare("SELECT * FROM billing_payments WHERE order_id=? FOR UPDATE").get(orderId);
        if (!row || row.status === "paid" || Number(row.amount_paise) !== amount || String(payment?.currency || order?.currency || "INR") !== "INR") return;
        const update = await db.prepare("UPDATE billing_payments SET status='paid',payment_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='created' RETURNING id").get(paymentId,row.id);
        if (!update) return;
        let discount = null;
        const sub = await grantSubscription(db,row.user_id,amount,row.discount_code_id,paymentId,row.plan_type || "annual",false);
        if (row.discount_code_id) {
          discount = await db.prepare("SELECT * FROM billing_discount_codes WHERE id=?").get(row.discount_code_id);
          await redeemCode(db, discount, row.user_id, sub.id, amount, { enforceCurrentValidity: false });
        }
        await audit(db,row.user_id,"PAYMENT_CAPTURED",{orderId,paymentId,amount});
      });
    } catch (error) {
      console.error("[Jazz billing webhook]",error?.message || "failed");
      return reply(req,res,500,{ok:false,error:"Webhook processing failed; provider may retry"},json);
    }
    return reply(req,res,200,{ok:true},json);
  }

  const session = await sessionFor(req,res,json,requireSession);
  if (!session) return true;
  const userId = session.user_id;

  if (req.method === "GET" && path === "/api/billing/status") {
    const trial = await db.prepare("SELECT starts_at,expires_at FROM billing_trials WHERE user_id=?").get(userId);
    const subscription = await db.prepare("SELECT status,starts_at,expires_at,amount_paid_paise,plan_type FROM billing_subscriptions WHERE user_id=? AND status IN ('active','complimentary') ORDER BY expires_at DESC LIMIT 1").get(userId);
    const now = Date.now();
    const paid = Boolean(subscription && new Date(subscription.expires_at).getTime() > now);
    const trialing = Boolean(trial && new Date(trial.starts_at).getTime() <= now && new Date(trial.expires_at).getTime() > now);
    return reply(req,res,200,{ok:true,pricePaise:PLAN_PRICES_PAISE.annual,plans:PLAN_PRICES_PAISE,trial:trial ? {startsAt:trial.starts_at,expiresAt:trial.expires_at,active:trialing} : null,subscription:subscription ? {...subscription,active:paid} : null,access:paid ? "subscribed" : trialing ? "trial" : "expired",canUsePaidFeatures:paid || trialing},json);
  }

  if (req.method === "POST" && path === "/api/billing/discount/validate") {
    const body = await jsonBody(req,readJson);
    let plan;
    try { plan = normalizePlan(body.plan || "annual"); } catch (error) { return reply(req,res,error.status || 400,{ok:false,error:error.message},json); }
    let row;
    try { row = await getCode(body.code,db); } catch (error) { return reply(req,res,error.status || 503,{ok:false,error:error.message},json); }
    if (!codeIsValid(row) || !codeEligibleForPlan(row,plan)) return reply(req,res,200,{ok:true,valid:false,error:"This discount code is invalid, unavailable, or not eligible for the selected plan."},json);
    const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").get(row.id,userId);
    if (Number(used?.total || 0) >= Number(row.per_user_limit || 1)) return reply(req,res,200,{ok:true,valid:false,error:"This account has reached this discount code's per-user redemption limit."},json);
    return reply(req,res,200,{ok:true,valid:true,percentOff:Number(row.percent_off),amountPaise:discountedPrice(row.percent_off,plan),label:row.label,plan},json);
  }

  if (req.method === "POST" && path === "/api/billing/checkout") {
    const body = await jsonBody(req,readJson);
    let plan;
    try { plan = normalizePlan(body.plan || "annual"); } catch (error) { return reply(req,res,error.status || 400,{ok:false,error:error.message},json); }
    const activeSubscription = await db.prepare("SELECT id FROM billing_subscriptions WHERE user_id=? AND status IN ('active','complimentary') AND expires_at>CURRENT_TIMESTAMP LIMIT 1").get(userId);
    if (activeSubscription) return reply(req,res,409,{ok:false,error:"Your subscription is already active. You can subscribe again after the current access period ends."},json);
    let discount = null;
    if (String(body.code || "").trim()) {
      try { discount = await getCode(body.code,db); } catch (error) { return reply(req,res,error.status || 503,{ok:false,error:error.message},json); }
      if (!codeIsValid(discount) || !codeEligibleForPlan(discount,plan)) return reply(req,res,409,{ok:false,error:"This discount code is invalid, unavailable, or not eligible for the selected plan."},json);
      const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").get(discount.id,userId);
      if (Number(used?.total || 0) >= Number(discount.per_user_limit || 1)) return reply(req,res,409,{ok:false,error:"This account has reached this discount code's per-user redemption limit."},json);
    }
    const percent = Number(discount?.percent_off || 0);
    const amount = discount ? discountedPrice(percent,plan) : PLAN_PRICES_PAISE[plan];
    if (amount === 0) {
      try {
        const sub = await db.transaction(async () => {
          if (discount) {
            const locked = await db.prepare("SELECT * FROM billing_discount_codes WHERE id=? FOR UPDATE").get(discount.id);
            if (!codeIsValid(locked) || !codeEligibleForPlan(locked,plan)) throw Object.assign(new Error("This discount code is no longer available for the selected plan."),{status:409});
            const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").get(discount.id,userId);
            if (Number(used?.total || 0) >= Number(locked.per_user_limit || 1)) throw Object.assign(new Error("This account has reached this discount code's per-user redemption limit."),{status:409});
          }
          const result = await grantSubscription(db,userId,0,discount?.id || null,null,plan,true);
          if (discount) await redeemCode(db,discount,userId,result.id,0);
          await audit(db,userId,"COMPLIMENTARY_SUBSCRIPTION",{subscriptionId:result.id,discountId:discount?.id || null});
          return result;
        });
        return reply(req,res,200,{ok:true,complimentary:true,subscription:sub,amountPaise:0},json);
      } catch(error) { return reply(req,res,error.status || 500,{ok:false,error:error.message || "Could not grant complimentary access"},json); }
    }

    const keyId = String(process.env.RAZORPAY_KEY_ID || "");
    const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "");
    if (!keyId || !keySecret) return reply(req,res,503,{ok:false,error:"Razorpay is not configured yet"},json);
    const pending = await db.prepare("SELECT order_id,amount_paise,discount_code_id,plan_type FROM billing_payments WHERE user_id=? AND status='created' LIMIT 1").get(userId);
    if (pending) {
      const sameDiscount = String(pending.discount_code_id || "") === String(discount?.id || "");
      if (pending.plan_type === plan && Number(pending.amount_paise) === amount && sameDiscount) {
        return reply(req,res,200,{ok:true,keyId,orderId:pending.order_id,amountPaise:amount,currency:"INR",plan,description:plan === "monthly" ? "Jazz Recovery monthly subscription" : "Jazz Recovery annual subscription",resumed:true},json);
      }
      return reply(req,res,409,{ok:false,error:"You already have a pending checkout. Complete that payment first, or retry it with the same plan and discount code."},json);
    }
    const orderReceipt = "jz_" + crypto.randomBytes(12).toString("hex");
    let orderResponse;
    try {
      const response = await fetch("https://api.razorpay.com/v1/orders",{method:"POST",headers:{Authorization:"Basic "+Buffer.from(keyId+":"+keySecret).toString("base64"),"Content-Type":"application/json"},body:JSON.stringify({amount,currency:"INR",receipt:orderReceipt,notes:{jazzUserId:String(userId)}})});
      orderResponse = await response.json();
      if (!response.ok || !orderResponse.id) throw new Error("Razorpay order creation failed");
    } catch(error) { return reply(req,res,502,{ok:false,error:"Could not create a payment order. Please retry."},json); }
    try {
      await db.transaction(async () => {
        if (discount) {
          const locked = await db.prepare("SELECT * FROM billing_discount_codes WHERE id=? FOR UPDATE").get(discount.id);
          if (!codeIsValid(locked)) throw Object.assign(new Error("This discount code is no longer available."),{status:409});
          const used = await db.prepare("SELECT COUNT(*) AS total FROM billing_discount_redemptions WHERE discount_code_id=? AND user_id=?").get(discount.id,userId);
          if (Number(used?.total || 0) >= Number(locked.per_user_limit || 1)) {
            throw Object.assign(new Error("This account has reached this discount code's per-user redemption limit."),{status:409});
          }
          if (await db.prepare("SELECT id FROM billing_payments WHERE discount_code_id=? AND user_id=? AND status='created' LIMIT 1").get(discount.id,userId)) {
            throw Object.assign(new Error("A checkout for this code is already pending on this account."),{status:409});
          }
          const pending = Number((await db.prepare("SELECT COUNT(*) AS total FROM billing_payments WHERE discount_code_id=? AND status='created'").get(discount.id)).total || 0);
          if (locked.max_redemptions != null && Number(locked.redeemed_count) + pending >= Number(locked.max_redemptions)) {
            throw Object.assign(new Error("This discount code has reached its redemption limit."),{status:409});
          }
        }
        await db.prepare("INSERT INTO billing_payments(id,user_id,order_id,amount_paise,currency,status,discount_code_id,plan_type) VALUES(?,?,?,?,?,'created',?,?)")
          .run(crypto.randomUUID(),userId,orderResponse.id,amount,"INR",discount?.id || null,plan);
      });
    } catch(error) {
      return reply(req,res,error?.code === "23505" ? 409 : (error.status || 500),{ok:false,error:error?.code === "23505" ? "A checkout is already pending for this account." : (error.message || "Could not save payment order")},json);
    }
    return reply(req,res,201,{ok:true,keyId,orderId:orderResponse.id,amountPaise:amount,currency:"INR",plan,description:plan === "monthly" ? "Jazz Recovery monthly subscription" : "Jazz Recovery annual subscription"},json);
  }

  if (req.method === "POST" && path === "/api/billing/admin/claim") {
    const bootstrap = String(process.env.JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET || "");
    const supplied = String((await jsonBody(req,readJson)).bootstrapSecret || "");
    if (!bootstrap || !safeEqual(supplied,bootstrap)) return reply(req,res,403,{ok:false,error:"Invalid admin bootstrap secret"},json);
    try {
      await db.transaction(async () => {
        const count = Number((await db.prepare("SELECT COUNT(*) AS total FROM billing_admins").get()).total);
        if (count) throw Object.assign(new Error("An admin is already configured"),{status:409});
        await db.prepare("INSERT INTO billing_admins(user_id) VALUES(?) ON CONFLICT DO NOTHING").run(userId);
        await audit(db,userId,"BILLING_ADMIN_CLAIM",{});
      });
      return reply(req,res,201,{ok:true,isAdmin:true},json);
    } catch(error) { return reply(req,res,error.status || 500,{ok:false,error:error.message},json); }
  }

  if (path.startsWith("/api/billing/admin/")) {
    if (!(await adminCheck(userId,db))) return reply(req,res,403,{ok:false,error:"Owner/admin access required"},json);
    if (req.method === "GET" && path === "/api/billing/admin/discount-codes") {
      const rows = await db.prepare("SELECT id,label,percent_off,active,starts_at,expires_at,max_redemptions,redeemed_count,eligible_plan,per_user_limit,created_at,updated_at FROM billing_discount_codes ORDER BY created_at DESC").all();
      return reply(req,res,200,{ok:true,items:rows},json);
    }
    if (req.method === "POST" && path === "/api/billing/admin/discount-codes") {
      const body = await jsonBody(req,readJson);
      const percent = Number(body.percentOff);
      if (![10,20,50,100].includes(percent)) return reply(req,res,400,{ok:false,error:"Discount must be 10, 20, 50 or 100 percent."},json);
      const code = String(body.code || makeCode()).trim().toUpperCase();
      if (!/^[A-Z0-9-]{5,40}$/.test(code)) return reply(req,res,400,{ok:false,error:"Code must contain 5–40 letters, numbers or hyphens."},json);
      const label = String(body.label || (percent+"% discount")).trim().slice(0,100);
      const max = body.maxRedemptions == null || body.maxRedemptions === "" ? null : Number(body.maxRedemptions);
      if (max != null && (!Number.isInteger(max) || max < 1 || max > 1000000)) return reply(req,res,400,{ok:false,error:"Redemption limit must be a positive whole number."},json);
      if (percent === 100 && max == null) return reply(req,res,400,{ok:false,error:"A 100% complimentary code must have a maximum redemption limit."},json);
      const starts = body.startsAt ? new Date(body.startsAt) : new Date();
      const expires = body.expiresAt ? new Date(body.expiresAt) : null;
      const eligiblePlan = String(body.eligiblePlan || "annual");
      const perUserLimit = body.perUserLimit == null || body.perUserLimit === "" ? 1 : Number(body.perUserLimit);
      if (Number.isNaN(starts.getTime()) || (expires && Number.isNaN(expires.getTime())) || (expires && expires <= starts)) return reply(req,res,400,{ok:false,error:"Invalid discount start/end date range."},json);
      if (!["annual","monthly","both"].includes(eligiblePlan)) return reply(req,res,400,{ok:false,error:"Eligible plan must be annual, monthly or both."},json);
      if (!Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 1000000) return reply(req,res,400,{ok:false,error:"Per-user redemption limit must be a positive whole number."},json);
      try {
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO billing_discount_codes(id,code_hash,label,percent_off,starts_at,expires_at,max_redemptions,eligible_plan,per_user_limit,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(id,digestCode(code),label,percent,starts.toISOString(),expires ? expires.toISOString() : null,max,eligiblePlan,perUserLimit,userId);
        await audit(db,userId,"DISCOUNT_CREATED",{id,label,percentOff:percent});
        return reply(req,res,201,{ok:true,id,code,label,percentOff:percent,expiresAt:expires?.toISOString() || null,maxRedemptions:max},json);
      } catch(error) {
        if (error?.code === "23505") return reply(req,res,409,{ok:false,error:"That code already exists."},json);
        return reply(req,res,error.status || 500,{ok:false,error:error.message || "Could not create discount"},json);
      }
    }
    const actionMatch = path.match(/^\/api\/billing\/admin\/discount-codes\/([a-f0-9-]+)\/(disable|enable|rotate|update)$/i);
    if (req.method === "POST" && actionMatch) {
      const [,id,action] = actionMatch;
      const existing = await db.prepare("SELECT * FROM billing_discount_codes WHERE id=?").get(id);
      if (!existing) return reply(req,res,404,{ok:false,error:"Discount code not found"},json);
      if (action === "disable" || action === "enable") {
        const active = action === "enable";
        if (active && Number(existing.percent_off) === 100 && existing.max_redemptions == null) {
          return reply(req,res,409,{ok:false,error:"Set a maximum redemption limit before enabling a 100% complimentary code."},json);
        }
        await db.prepare("UPDATE billing_discount_codes SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(active,id);
        await audit(db,userId,active ? "DISCOUNT_ENABLED" : "DISCOUNT_DISABLED",{id});
        return reply(req,res,200,{ok:true,active},json);
      }
      if (action === "rotate") {
        const code = String((await jsonBody(req,readJson)).code || makeCode()).trim().toUpperCase();
        if (!/^[A-Z0-9-]{5,40}$/.test(code)) return reply(req,res,400,{ok:false,error:"Invalid replacement code."},json);
        try {
          await db.prepare("UPDATE billing_discount_codes SET code_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(digestCode(code),id);
          await audit(db,userId,"DISCOUNT_ROTATED",{id});
          return reply(req,res,200,{ok:true,id,code},json);
        } catch(error) { return reply(req,res,error?.code === "23505" ? 409 : 500,{ok:false,error:"Could not rotate code"},json); }
      }
      const body = await jsonBody(req,readJson);
      const percent = body.percentOff == null ? Number(existing.percent_off) : Number(body.percentOff);
      if (![10,20,50,100].includes(percent)) return reply(req,res,400,{ok:false,error:"Discount must be 10, 20, 50 or 100 percent."},json);
      const starts = body.startsAt === undefined ? new Date(existing.starts_at) : (body.startsAt ? new Date(body.startsAt) : new Date());
      const expires = body.expiresAt === undefined ? (existing.expires_at ? new Date(existing.expires_at) : null) : (body.expiresAt ? new Date(body.expiresAt) : null);
      const max = body.maxRedemptions === undefined ? existing.max_redemptions : (body.maxRedemptions === "" || body.maxRedemptions == null ? null : Number(body.maxRedemptions));
      const eligiblePlan = body.eligiblePlan === undefined ? String(existing.eligible_plan || "annual") : String(body.eligiblePlan);
      const perUserLimit = body.perUserLimit === undefined ? Number(existing.per_user_limit || 1) : Number(body.perUserLimit);
      if (Number.isNaN(starts.getTime()) || (expires && Number.isNaN(expires.getTime())) || (expires && expires <= starts)) return reply(req,res,400,{ok:false,error:"Invalid discount start/end date range."},json);
      if (!["annual","monthly","both"].includes(eligiblePlan)) return reply(req,res,400,{ok:false,error:"Eligible plan must be annual, monthly or both."},json);
      if (!Number.isInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 1000000) return reply(req,res,400,{ok:false,error:"Per-user redemption limit must be a positive whole number."},json);
      if (max != null && (!Number.isInteger(max) || max < 1 || max < Number(existing.redeemed_count))) return reply(req,res,400,{ok:false,error:"Redemption limit must be positive and cannot be below existing redemptions."},json);
      if (percent === 100 && max == null) return reply(req,res,400,{ok:false,error:"A 100% complimentary code must have a maximum redemption limit."},json);
      await db.prepare("UPDATE billing_discount_codes SET percent_off=?,starts_at=?,expires_at=?,max_redemptions=?,eligible_plan=?,per_user_limit=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(percent,starts.toISOString(),expires ? expires.toISOString() : null,max,eligiblePlan,perUserLimit,id);
      await audit(db,userId,"DISCOUNT_UPDATED",{id,percentOff:percent});
      return reply(req,res,200,{ok:true},json);
    }
  }
  return reply(req,res,404,{ok:false,error:"Billing endpoint not found"},json);
}
