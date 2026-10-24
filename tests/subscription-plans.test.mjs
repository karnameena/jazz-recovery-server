import test from "node:test";
import assert from "node:assert/strict";
import { discountedPrice, PLAN_PRICES_PAISE, planExpiry } from "../src/pg/billing.mjs";

test("server-side plan prices are exact integer paise", () => {
  assert.deepEqual(PLAN_PRICES_PAISE, { monthly: 4900, annual: 39900 });
});

test("annual discount amounts are calculated from ₹399", () => {
  assert.equal(discountedPrice(10), 35910);
  assert.equal(discountedPrice(20), 31920);
  assert.equal(discountedPrice(50), 19950);
  assert.equal(discountedPrice(100), 0);
});

test("discount codes cannot be applied to monthly plan", () => {
  assert.throws(() => discountedPrice(10, "monthly"), /annual plan only/);
});

test("unsupported discounts and plans are rejected", () => {
  for (const percent of [0, 1, 30, 101, -10, "50"]) assert.throws(() => discountedPrice(percent));
  assert.throws(() => planExpiry(Date.UTC(2026, 0, 1), "weekly"), /Choose a valid subscription plan/);
});

test("monthly expiry advances one calendar month and clamps end-of-month dates", () => {
  assert.equal(planExpiry(Date.UTC(2026, 0, 31, 12), "monthly").toISOString(), "2026-02-28T12:00:00.000Z");
  assert.equal(planExpiry(Date.UTC(2024, 0, 31, 12), "monthly").toISOString(), "2024-02-29T12:00:00.000Z");
});

test("annual expiry advances twelve calendar months and clamps leap day", () => {
  assert.equal(planExpiry(Date.UTC(2024, 1, 29, 12), "annual").toISOString(), "2025-02-28T12:00:00.000Z");
  assert.equal(planExpiry(Date.UTC(2026, 9, 24, 12), "annual").toISOString(), "2027-10-24T12:00:00.000Z");
});
