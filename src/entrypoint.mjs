// Jazz Recovery production runtime is PostgreSQL-only. Missing configuration fails closed.
const engine = String(process.env.JAZZ_DB_ENGINE || "").trim().toLowerCase();
if (engine !== "postgres") {
  throw new Error("Jazz Recovery requires JAZZ_DB_ENGINE=postgres. SQLite fallback is disabled.");
}
if (!String(process.env.DATABASE_URL || "").trim()) {
  throw new Error("DATABASE_URL is required for JAZZ_DB_ENGINE=postgres.");
}
await import("./pg/server.mjs");
