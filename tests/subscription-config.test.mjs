import test from "node:test";
import assert from "node:assert/strict";
import { TRIAL_DAYS, TRIAL_USERS, getTrialConfigForUsername, normalizeTrialUsers, PLAN_CONFIG, PLAN_PRICES_PAISE, PLAN_DURATIONS_MONTHS } from "../src/pg/subscription-config.mjs";
import { planExpiry } from "../src/pg/billing.mjs";

test("new eligible accounts receive a seven-day trial by default", () => {
  assert.equal(TRIAL_DAYS, 7);
});

test("monthly and yearly plan prices and durations come from subscription-config.json", () => {
  assert.deepEqual(PLAN_PRICES_PAISE, { monthly: 4900, annual: 39900 });
  assert.deepEqual(PLAN_DURATIONS_MONTHS, { monthly: 1, annual: 12 });
  assert.equal(PLAN_CONFIG.monthly.label, "Monthly");
  assert.equal(PLAN_CONFIG.annual.label, "Yearly");
});

test("configured monthly plan expiry handles short calendar months", () => {
  assert.equal(planExpiry(Date.UTC(2026, 0, 31, 12), "monthly").toISOString(), "2026-02-28T12:00:00.000Z");
});

test("configured yearly plan expiry handles leap day", () => {
  assert.equal(planExpiry(Date.UTC(2024, 1, 29, 12), "annual").toISOString(), "2025-02-28T12:00:00.000Z");
});

test("per-user trial overrides are looked up case-insensitively and unlisted users use the default policy", () => {
  assert.deepEqual(TRIAL_USERS, {});
  assert.equal(getTrialConfigForUsername("new-user"), null);
  assert.equal(getTrialConfigForUsername(" KARnameena1 "), null);
});

test("manual per-user trial dates normalize timezone offsets and match usernames case-insensitively", () => {
  const users = normalizeTrialUsers({
    "karnameena1": {
      enabled: true,
      startDate: "2026-10-25T00:00:00+05:30",
      endDate: "2026-11-01T23:59:59+05:30",
      description: "Manually managed trial period"
    }
  });
  assert.deepEqual(users.karnameena1, {
    enabled: true,
    startsAt: "2026-10-24T18:30:00.000Z",
    endsAt: "2026-11-01T18:29:59.000Z",
    description: "Manually managed trial period"
  });
  assert.equal(normalizeTrialUsers({}).karnameena1, undefined);
});

test("manual per-user trial dates reject missing timezone offsets and invalid date ranges", () => {
  assert.throws(() => normalizeTrialUsers({
    user_one: { enabled: true, startDate: "2026-10-25T00:00:00", endDate: "2026-11-01T23:59:59+05:30", description: "" }
  }), /timezone offset/);
  assert.throws(() => normalizeTrialUsers({
    user_one: { enabled: true, startDate: "2026-11-02T00:00:00+05:30", endDate: "2026-11-01T23:59:59+05:30", description: "" }
  }), /endDate after startDate/);
});
