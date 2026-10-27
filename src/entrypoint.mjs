// Jazz Recovery persistent runtime data must use PostgreSQL only.
const engine = String(process.env.JAZZ_DB_ENGINE || "postgres").toLowerCase();
if (engine !== "postgres") {
  throw new Error("Jazz Recovery runtime requires JAZZ_DB_ENGINE=postgres; SQLite runtime is disabled");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for JAZZ_DB_ENGINE=postgres");
}
await import("./pg/server.mjs");
