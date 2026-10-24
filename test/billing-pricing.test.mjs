import test from "node:test";
import assert from "node:assert/strict";
import { discountedPrice } from "../src/pg/billing.mjs";

test("annual subscription discount amounts are exact in paise", () => {
  assert.equal(discountedPrice(10), 35910);
  assert.equal(discountedPrice(20), 31920);
  assert.equal(discountedPrice(50), 19950);
  assert.equal(discountedPrice(100), 0);
});

test("unsupported discounts are rejected", () => {
  for (const percent of [0, 1, 30, 101, -10, "50"]) {
    assert.throws(() => discountedPrice(percent));
  }
});
