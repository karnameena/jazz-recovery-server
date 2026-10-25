import { applyMigrations, closeDatabase, db } from "../pg/database.mjs";

try {
  await applyMigrations();
  const rows = await db.prepare(`
    SELECT u.username,
           CASE WHEN a.user_id IS NULL THEN 'NO' ELSE 'YES' END AS billing_admin
    FROM users u
    LEFT JOIN billing_admins a ON a.user_id = u.id
    ORDER BY LOWER(u.username), u.username
  `).all();

  if (!rows.length) {
    console.log("No registered user accounts found.");
  } else {
    console.log("Registered usernames (no passwords or hashes are shown):");
    for (const row of rows) {
      console.log(`- ${row.username} | Billing admin: ${row.billing_admin}`);
    }
  }
} finally {
  await closeDatabase();
}
