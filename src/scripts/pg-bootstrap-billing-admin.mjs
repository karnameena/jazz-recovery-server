import crypto from "node:crypto";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { applyMigrations, closeDatabase, db } from "../pg/database.mjs";

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue || ""));
  const right = Buffer.from(String(rightValue || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

if (String(process.env.JAZZ_DB_ENGINE || "").toLowerCase() !== "postgres" || !process.env.DATABASE_URL) {
  throw new Error("Billing administrator bootstrap requires JAZZ_DB_ENGINE=postgres and DATABASE_URL.");
}
const configuredSecret = String(process.env.JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET || "");
if (configuredSecret.length < 32 || /replace-with|change-me|example/i.test(configuredSecret)) {
  throw new Error("Set a strong private JAZZ_BILLING_ADMIN_BOOTSTRAP_SECRET (at least 32 characters) in server/.env first.");
}

const rl = readline.createInterface({ input, output });
try {
  await applyMigrations();
  const username = (await rl.question("Existing registered username to designate as billing administrator: ")).trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) throw new Error("Enter a valid existing username.");
  const secret = await rl.question("Enter the configured billing bootstrap secret: ");
  if (!safeEqual(secret, configuredSecret)) throw new Error("Bootstrap secret did not match. No changes were made.");
  const target = await db.prepare("SELECT id,username FROM users WHERE LOWER(username)=LOWER(?)").get(username);
  if (!target) throw new Error("That registered account was not found. No changes were made.");
  const result = await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(7482363)").get();
    const existing = await db.prepare("SELECT user_id FROM billing_admins").all();
    if (existing.some(row => Number(row.user_id) === Number(target.id))) return { already: true };
    if (existing.length) throw new Error("A billing administrator is already configured. This one-time bootstrap will not replace that account.");
    await db.prepare("INSERT INTO billing_admins(user_id) VALUES(?)").run(target.id);
    await db.prepare("INSERT INTO billing_audit(actor_user_id,action,details) VALUES(?,?,?)")
      .run(target.id, "BILLING_ADMIN_BOOTSTRAPPED", JSON.stringify({ targetUserId: target.id }));
    return { created: true };
  });
  console.log(result.already ? `${target.username} already has billing administrator access.` : `Billing administrator access granted to ${target.username}.`);
  console.log("The bootstrap is now closed. The secret is not stored in the browser or returned by the API.");
} finally {
  rl.close();
  await closeDatabase();
}
