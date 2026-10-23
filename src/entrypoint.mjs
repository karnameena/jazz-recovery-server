// Jazz Recovery has one supported runtime database: Neon PostgreSQL.
// Fail closed when configuration is missing or asks for a legacy engine.
// Never silently start against a local SQLite file.
const engine = String(process.env.JAZZ_DB_ENGINE || "postgres").trim().toLowerCase();

if (engine !== "postgres") {
  throw new Error(
    "Unsupported JAZZ_DB_ENGINE. Jazz Recovery requires PostgreSQL; set JAZZ_DB_ENGINE=postgres."
  );
}

if (!String(process.env.DATABASE_URL || "").trim()) {
  throw new Error(
    "DATABASE_URL is required. Configure the Neon PostgreSQL connection in the private server environment."
  );
}

await import("./pg/server.mjs");
