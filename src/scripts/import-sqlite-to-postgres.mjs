// Read-only SQLite -> PostgreSQL import. Never uploads a database to GitHub.
// Dry-run unless BOTH --apply and JAZZ_CONFIRM_MIGRATION=YES are supplied.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const sourceFile = String(process.env.JAZZ_SQLITE_SOURCE || "").trim();
if (!sourceFile || !fs.existsSync(sourceFile)) {
  throw new Error("JAZZ_SQLITE_SOURCE must point to an existing private SQLite backup.");
}
const apply = process.argv.includes("--apply");
if (apply && process.env.JAZZ_CONFIRM_MIGRATION !== "YES") {
  throw new Error("Refusing import: set JAZZ_CONFIRM_MIGRATION=YES and pass --apply.");
}

const tables = {
  users: ["id","username","password_hash","created_at","updated_at"],
  devices: ["id","user_id","device_id","device_name","device_type","credential_hash","created_at","updated_at"],
  device_state: ["device_id","mode","battery","charging","network","online","last_seen",
    "latitude","longitude","accuracy_meters","location_timestamp",
    "photo_data_url","photo_camera","photo_timestamp","updated_at",
    "location_services_status","location_services_timestamp"],
  recovery_commands: ["id","device_id","type","args_json","status","created_at","leased_until","completed_at","result_json"],
  recovery_audit: ["id","user_id","device_id","action","status","created_at"]
};
const ordered = Object.keys(tables);
const temporal = new Set(["created_at","updated_at","last_seen","leased_until","completed_at"]);
const source = new DatabaseSync(sourceFile, { readOnly: true });

function parseTimestamp(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
    ? raw.replace(" ", "T") + "Z" : raw;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid timestamp in SQLite backup");
  return date;
}

async function run() {
  const health = source.prepare("PRAGMA quick_check").get();
  if (health.quick_check !== "ok") throw new Error("SQLite backup integrity check failed");
  if (source.prepare("PRAGMA foreign_key_check").all().length) {
    throw new Error("SQLite backup contains broken foreign-key relationships");
  }

  const counts = {};
  for (const table of ordered) {
    counts[table] = source.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
  }
  if (!counts.users || !counts.devices) throw new Error("Source owner/device rows not found");

  console.log("SQLite backup verified. Table counts (no secrets):", counts);
  if (!apply) {
    console.log("DRY RUN ONLY. Nothing was copied to PostgreSQL.");
    console.log("To import, use --apply with JAZZ_CONFIRM_MIGRATION=YES after reviewing destination.");
    return;
  }

  const { applyMigrations, closeDatabase, db } = await import("../pg/database.mjs");
  try {
  await applyMigrations();
  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(7482362)").get();

    // Require a completely empty destination: no merge, no overwrite, no
    // loss of unrelated existing owners or devices.
    for (const table of [...ordered, "sessions"]) {
      const count = await db.prepare("SELECT COUNT(*) AS n FROM " + table).get();
      if (Number(count.n) !== 0) throw new Error("Destination is not empty (" + table + "); import aborted.");
    }

    for (const table of ordered) {
      const columns = tables[table];
      const existing = new Set(source.prepare("PRAGMA table_info(" + table + ")").all().map(row => row.name));
      const selected = columns.filter(col => existing.has(col));
      // A pre-002 SQLite backup does not include location_services_status:
      // PostgreSQL's schema default handles that column safely.
      const placeholders = selected.map((_, i) => "$" + (i + 1)).join(",");
      const insert = "INSERT INTO " + table + "(" + selected.join(",") + ") VALUES(" + placeholders + ")";
      const stmt = source.prepare("SELECT " + selected.join(",") + " FROM " + table);
      for (const row of stmt.iterate()) {
        const values = selected.map(column => temporal.has(column) ? parseTimestamp(row[column]) : row[column]);
        await db.prepare(insert.replace(/\$\d+/g, "?")).run(...values);
      }
    }

    // Newly restored commands must NEVER run long after they were queued.
    await db.prepare("UPDATE recovery_commands SET status='expired',completed_at=CURRENT_TIMESTAMP,leased_until=NULL WHERE status='pending'").run();

    for (const table of ordered) {
      const result = await db.prepare("SELECT COUNT(*) AS n FROM " + table).get();
      if (Number(result.n) !== counts[table]) throw new Error("Count mismatch after " + table);
    }

    // PostgreSQL IDENTITY sequences must advance past imported SQLite IDs.
    for (const table of ["users","devices","recovery_audit"]) {
      const max = await db.prepare("SELECT MAX(id) AS n FROM " + table).get();
      if (max.n != null) {
        await db.prepare("SELECT setval(pg_get_serial_sequence('" + table + "','id'), ?, true)").get(max.n);
      }
    }

    // Compare sensitive hashes privately without displaying any credentials.
    for (const row of source.prepare("SELECT id,password_hash FROM users").iterate()) {
      const restored = await db.prepare("SELECT password_hash FROM users WHERE id=?").get(row.id);
      if (restored?.password_hash !== row.password_hash) throw new Error("Owner password hash mismatch");
    }
    for (const row of source.prepare("SELECT device_id,credential_hash FROM devices").iterate()) {
      const restored = await db.prepare("SELECT credential_hash FROM devices WHERE device_id=?").get(row.device_id);
      if (restored?.credential_hash !== row.credential_hash) throw new Error("Device credential hash mismatch");
    }
  });
  } finally { await closeDatabase(); }
  console.log("Import committed and validated; existing owner/device IDs and hashes preserved.");
  console.log("Existing sessions were not imported; log in again. Pending commands were safely expired.");
}

try { await run(); }
finally { source.close(); }
