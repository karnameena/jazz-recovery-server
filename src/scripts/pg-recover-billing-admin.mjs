import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { applyMigrations, closeDatabase, db } from "../pg/database.mjs";

const rl = readline.createInterface({ input, output });
try {
  await applyMigrations();
  const username = (await rl.question("Existing registered username to make billing admin: ")).trim();
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new Error("Enter a valid existing username (3-64 letters, numbers, dot, underscore or dash).");
  }

  const target = await db.prepare("SELECT id, username FROM users WHERE LOWER(username)=LOWER(?)").get(username);
  if (!target) {
    throw new Error("That username does not exist. Run 'npm run list-users' to inspect registered usernames.");
  }

  const result = await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(7482362)").get();
    const current = await db.prepare("SELECT user_id FROM billing_admins").all();
    if (current.some(row => Number(row.user_id) === Number(target.id))) {
      return { alreadyAdmin: true, username: target.username };
    }

    if (current.length) {
      const confirmation = await rl.question(
        "A billing admin already exists. To transfer the billing-admin role to this existing account (without deleting users, devices, subscriptions, or other data), type REASSIGN BILLING ADMIN: "
      );
      if (confirmation.trim() !== "REASSIGN BILLING ADMIN") {
        throw new Error("Cancelled. No billing-admin role was changed.");
      }
      await db.prepare("DELETE FROM billing_admins").run();
    }

    await db.prepare("INSERT INTO billing_admins(user_id) VALUES(?)").run(target.id);
    return { alreadyAdmin: false, username: target.username };
  });

  if (result.alreadyAdmin) {
    console.log(`'${result.username}' already has billing-admin access. No changes were made.`);
  } else {
    console.log(`Billing-admin access is now assigned to '${result.username}'. No user/device/subscription records were deleted.`);
    console.log("If you also forgot the password, run 'npm run change-owner-password' and enter this username.");
  }
} finally {
  rl.close();
  await closeDatabase();
}
