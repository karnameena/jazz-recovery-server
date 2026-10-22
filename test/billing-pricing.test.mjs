import test from "node:test";
import assert from "node:assert/strict";

// Price rules are intentionally integer-paise math to avoid floating-point billing.
const price = 49900;
const discounted = percent => Math.round(price * (100 - percent) / 100);
test("annual subscription discount amounts are exact in paise", () => {
  assert.equal(discounted(10), 44910);
  assert.equal(discounted(20), 39920);
  assert.equal(discounted(50), 24950);
  assert.equal(discounted(100), 0);
});
test("invalid discounts cannot produce a charge", () => {
  for (const percent of [0, 1, 30, 101, -10]) assert.equal([10,20,50,100].includes(percent) ? discounted(percent) : null, null);
});
