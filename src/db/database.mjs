import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(here, "../..");
const configured = String(process.env.LOST_MODE_DB_PATH || "./data/lost-mode.db").trim();
const dbPath = path.isAbsolute(configured) ? configured : path.resolve(serviceRoot, configured);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;");

export function applyMigrations() {
  const migrationsDir = path.resolve(serviceRoot, "migrations");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const files = fs.readdirSync(migrationsDir).filter(name => name.endsWith(".sql")).sort();
  const has = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?");
  const mark = db.prepare("INSERT INTO schema_migrations(name) VALUES (?)");
  for (const name of files) {
    if (has.get(name)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, name), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      mark.run(name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function cleanupExpiredSessions() {
  // expires_at is stored as ISO-8601 text while SQLite CURRENT_TIMESTAMP uses
  // "YYYY-MM-DD HH:MM:SS". Compare parsed dates, not raw strings.
  db.prepare("DELETE FROM sessions WHERE julianday(expires_at) IS NULL OR julianday(expires_at) <= julianday('now')").run();
}

export function databasePath() { return dbPath; }
