import test from "node:test";
import assert from "node:assert/strict";
import { discountedPrice } from "../src/pg/billing.mjs";

test("annual subscription discount amounts are exact in paise", () => {
  assert.equal(discountedPrice(10), 44910);
  assert.equal(discountedPrice(20), 39920);
  assert.equal(discountedPrice(50), 24950);
  assert.equal(discountedPrice(100), 0);
});

test("unsupported discounts are rejected", () => {
  for (const percent of [0, 1, 30, 101, -10, "50"]) {
    assert.throws(() => discountedPrice(percent));
  }
});
