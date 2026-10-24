// Jazz Recovery hosted billing/recovery runtime is PostgreSQL-only.
// Fail closed if the deployment is not explicitly configured for Neon/PostgreSQL.
const engine = String(process.env.JAZZ_DB_ENGINE || "").toLowerCase();
if (engine !== "postgres") {
  throw new Error("Jazz Recovery hosted runtime requires JAZZ_DB_ENGINE=postgres; SQLite fallback is disabled.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the PostgreSQL runtime.");
}
await import("./pg/server.mjs");
