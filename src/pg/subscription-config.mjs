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
