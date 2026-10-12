// Fail closed: PostgreSQL is opt-in, and an accidental DATABASE_URL does not
// silently change an existing SQLite installation.
const engine = String(process.env.JAZZ_DB_ENGINE || "sqlite").toLowerCase();
if (engine === "postgres") {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for JAZZ_DB_ENGINE=postgres");
  await import("./pg/server.mjs");
} else if (engine === "sqlite") {
  await import("./server.mjs");
} else {
  throw new Error("Unsupported JAZZ_DB_ENGINE (use sqlite or postgres)");
}
