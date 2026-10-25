import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function readConfig(name) {
  const fullPath = path.join(root, name);
  let value;
  try { value = JSON.parse(fs.readFileSync(fullPath, "utf8")); }
  catch { throw new Error(`Invalid or missing ${name}; restore the tracked configuration file.`); }
  return value;
}
const trial = readConfig("trial.config.json");
const subscription = readConfig("subscription-config.json");
if (!Number.isInteger(trial.trialDays) || trial.trialDays < 0 || trial.trialDays > 365) throw new Error("trial.config.json trialDays must be an integer from 0 to 365.");
if (trial.users == null || typeof trial.users !== "object" || Array.isArray(trial.users)) throw new Error("trial.config.json users must be an object keyed by username.");
export function normalizeTrialUsers(users) {
  if (users == null || typeof users !== "object" || Array.isArray(users)) throw new Error("trial.config.json users must be an object keyed by username.");
  const configuredTrials = {};
  for (const [username, entry] of Object.entries(users)) {
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Error(`trial.config.json has invalid username key: ${username}`);
    if (!entry || typeof entry !== "object" || typeof entry.enabled !== "boolean") throw new Error(`trial.config.json users.${username}.enabled must be true or false.`);
    if (typeof entry.description !== "string") throw new Error(`trial.config.json users.${username}.description must be a string.`);
    if (typeof entry.startDate !== "string" || typeof entry.endDate !== "string" ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(entry.startDate) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(entry.endDate)) {
      throw new Error(`trial.config.json users.${username} dates must be ISO timestamps with a timezone offset.`);
    }
    const startsAt = Date.parse(entry.startDate);
    const endsAt = Date.parse(entry.endDate);
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
      throw new Error(`trial.config.json users.${username} must have valid dates and endDate after startDate.`);
    }
    configuredTrials[username.toLowerCase()] = Object.freeze({
      enabled: entry.enabled,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString(),
      description: entry.description
    });
  }
  return Object.freeze(configuredTrials);
}
const configuredTrials = normalizeTrialUsers(trial.users);
if (!subscription.plans || !subscription.plans.monthly || !subscription.plans.annual) throw new Error("subscription-config.json must define monthly and annual plans.");
for (const name of ["monthly", "annual"]) {
  const plan = subscription.plans[name];
  if (!Number.isSafeInteger(plan.pricePaise) || plan.pricePaise < 0 || !Number.isInteger(plan.durationMonths) || plan.durationMonths < 1 || plan.durationMonths > 120) {
    throw new Error(`subscription-config.json has invalid ${name} plan settings.`);
  }
}
export const TRIAL_DAYS = trial.trialDays;
export const PLAN_CONFIG = Object.freeze({
  monthly: Object.freeze({ ...subscription.plans.monthly }),
  annual: Object.freeze({ ...subscription.plans.annual })
});
export const PLAN_PRICES_PAISE = Object.freeze({ monthly: PLAN_CONFIG.monthly.pricePaise, annual: PLAN_CONFIG.annual.pricePaise });
export const PLAN_DURATIONS_MONTHS = Object.freeze({ monthly: PLAN_CONFIG.monthly.durationMonths, annual: PLAN_CONFIG.annual.durationMonths });

export const TRIAL_USERS = Object.freeze(configuredTrials);
export function getTrialConfigForUsername(username) {
  return TRIAL_USERS[String(username || "").trim().toLowerCase()] || null;
}
