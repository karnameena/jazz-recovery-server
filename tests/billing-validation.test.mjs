import test from "node:test";
import assert from "node:assert/strict";
import { discountedPrice, planExpiry } from "../src/pg/billing.mjs";

test("annual discount calculations use paise and round correctly", () => {
  assert.equal(discountedPrice(10, "annual"), 35910);
  assert.equal(discountedPrice(20, "annual"), 31920);
  assert.equal(discountedPrice(50, "annual"), 19950);
});

test("discounts cannot be applied to monthly plans", () => {
  assert.throws(() => discountedPrice(10, "monthly"), /only to the annual plan/i);
});

test("100 percent and unsupported discounts are rejected", () => {
  assert.throws(() => discountedPrice(100, "annual"), /10%, 20% or 50%/);
  assert.throws(() => discountedPrice(15, "annual"), /10%, 20% or 50%/);
});

test("monthly plan expiry preserves end-of-month calendar behaviour", () => {
  const expiry = planExpiry(Date.parse("2026-01-31T12:00:00.000Z"), "monthly");
  assert.equal(expiry.toISOString(), "2026-02-28T12:00:00.000Z");
});

test("annual plan expiry preserves leap-day calendar behaviour", () => {
  const expiry = planExpiry(Date.parse("2024-02-29T12:00:00.000Z"), "annual");
  assert.equal(expiry.toISOString(), "2025-02-28T12:00:00.000Z");
});

import { getBillingAccess, handleBillingRoute } from "../src/pg/billing.mjs";

function fakeResponseHarness({ admin = false, trial = null, subscription = null, discount = null } = {}) {
  const store = { intents: [], admins: admin ? [7] : [], audit: [], trial, subscription, discount };
  const db = {
    prepare(sql) {
      return {
        async get(...args) {
          if (sql.includes("FROM billing_trials")) return store.trial;
          if (sql.includes("FROM billing_subscriptions")) return store.subscription;
          if (sql.includes("FROM billing_payment_intents")) return null;
          if (sql.includes("FROM billing_admins")) {
            if (sql.includes("COUNT(*)")) return { total: store.admins.length };
            return store.admins.includes(args[0]) ? { user_id: args[0] } : null;
          }
          if (sql.includes("FROM billing_discount_codes")) return store.discount;
          if (sql.includes("FROM billing_discount_redemptions")) return { total: 0 };
          return null;
        },
        async all() { return []; },
        async run(...args) {
          if (sql.includes("INSERT INTO billing_payment_intents")) store.intents.push({ id: args[0], user_id: args[1], plan_type: args[2], amount_paise: args[3], discount_code_id: args[4], payment_url: args[5], status: args[6] });
          if (sql.includes("INSERT INTO billing_admins")) store.admins.push(args[0]);
          if (sql.includes("INSERT INTO billing_audit")) store.audit.push({ action: args[1], details: args[2] });
          return { changes: 1 };
        }
      };
    },
    async transaction(action) { return action(); }
  };
  const response = {};
  const json = (_req, res, status, body) => { res.statusCode = status; res.body = body; };
  const req = { method: "GET", socket: { remoteAddress: "127.0.0.1" } };
  const requireSession = async () => ({ user_id: 7, username: "tester" });
  const readJson = async request => request.body || {};
  return { store, db, response, json, req, requireSession, readJson };
}

test("billing status is expired by default and never derives access from the browser", async () => {
  const h = fakeResponseHarness();
  await handleBillingRoute({ req: h.req, res: h.response, path: "/api/billing/status", db: h.db, json: h.json, readJson: h.readJson, requireSession: h.requireSession });
  assert.equal(h.response.statusCode, 200);
  assert.equal(h.response.body.access, "expired");
  assert.equal(h.response.body.isBillingAdmin, false);
});

test("monthly checkout records a pending intent and returns the exact Razorpay link without activation", async () => {
  const h = fakeResponseHarness();
  h.req.method = "POST";
  h.req.body = { plan: "monthly" };
  await handleBillingRoute({ req: h.req, res: h.response, path: "/api/billing/checkout", db: h.db, json: h.json, readJson: h.readJson, requireSession: h.requireSession });
  assert.equal(h.response.statusCode, 200);
  assert.equal(h.response.body.paymentUrl, "https://rzp.io/rzp/PEy4Ttqm");
  assert.equal(h.response.body.pending, true);
  assert.equal(h.store.intents.length, 1);
  assert.equal(h.store.intents[0].status, "pending");
});

test("normal users cannot read the billing administrator ledger", async () => {
  const h = fakeResponseHarness();
  h.req.method = "GET";
  await handleBillingRoute({ req: h.req, res: h.response, path: "/api/billing/admin/user-ledger", db: h.db, json: h.json, readJson: h.readJson, requireSession: h.requireSession });
  assert.equal(h.response.statusCode, 403);
});

test("a future trial is pending, not expired or subscribed", async () => {
  const h = fakeResponseHarness({ trial: { starts_at: new Date(Date.now() + 86_400_000).toISOString(), expires_at: new Date(Date.now() + 8 * 86_400_000).toISOString() } });
  const access = await getBillingAccess(h.db, 7);
  assert.equal(access.access, "trial_pending");
  assert.equal(access.allowed, false);
});

test("a current trial grants access and an expired trial does not", async () => {
  const active = fakeResponseHarness({ trial: { starts_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 86_400_000).toISOString() } });
  assert.equal((await getBillingAccess(active.db, 7)).access, "trial");
  const expired = fakeResponseHarness({ trial: { starts_at: new Date(Date.now() - 8 * 86_400_000).toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await getBillingAccess(expired.db, 7)).access, "expired");
});

test("discounted annual checkout remains pending and never returns a fixed-price payment link", async () => {
  const h = fakeResponseHarness({ discount: { id: "discount-1", code_hash: "unused", label: "10 percent", percent_off: 10, active: true, starts_at: new Date(Date.now() - 1000).toISOString(), expires_at: null, trial_eligible_from: null, trial_eligible_until: null, max_redemptions: null, redeemed_count: 0, eligible_plan: "annual", per_user_limit: 1 } });
  const previous = process.env.JAZZ_DISCOUNT_CODE_PEPPER;
  process.env.JAZZ_DISCOUNT_CODE_PEPPER = "test-only-discount-pepper";
  try {
    h.req.method = "POST"; h.req.body = { plan: "annual", code: "JAZZ10" };
    await handleBillingRoute({ req: h.req, res: h.response, path: "/api/billing/checkout", db: h.db, json: h.json, readJson: h.readJson, requireSession: h.requireSession });
    assert.equal(h.response.statusCode, 202);
    assert.equal(h.response.body.amountPaise, 35910);
    assert.equal(h.response.body.paymentUrl, null);
    assert.equal(h.response.body.pending, true);
    assert.equal(h.store.intents[0].status, "awaiting_dynamic_checkout");
  } finally {
    if (previous === undefined) delete process.env.JAZZ_DISCOUNT_CODE_PEPPER;
    else process.env.JAZZ_DISCOUNT_CODE_PEPPER = previous;
  }
});
