import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = String(process.env.DATABASE_URL || "").trim();
if (!url) throw new Error("PostgreSQL mode requires DATABASE_URL in the server's private environment.");

const { Pool, types } = pg;
// Database IDs use INTEGER; the BIGINT values in the schema are epoch-millisecond
// timestamps, which fit within JavaScript's safe integer range.
types.setTypeParser(20, value => Number(value));

// PostgreSQL integration tests may use plaintext ONLY on loopback in
// non-production. Neon and every remote database must use verified TLS.
const dbHostname = new URL(url).hostname.toLowerCase();
const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(dbHostname);
const insecureTest = process.env.JAZZ_PG_ALLOW_INSECURE_LOCALHOST === "true" &&
  process.env.NODE_ENV !== "production" && loopback;

export const pool = new Pool({
  connectionString: url,
  ssl: insecureTest ? false : { rejectUnauthorized: true },
  max: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000
});
pool.on("error", error => console.error("[Jazz Lost Mode] PostgreSQL pool error:", error.code || error.name));

const context = new AsyncLocalStorage();
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.resolve(here, "../../migrations/postgres");

// SQL is an internal trusted literal, never user input. All user values are
// parameterized. SQLite's ? placeholders are translated to PostgreSQL $n.
function translate(sql) {
  let text = sql.replace(/username\s*=\s*\?\s+COLLATE\s+NOCASE/gi, "LOWER(username)=LOWER(?)");
  let n = 0;
  return text.replace(/\?/g, () => "$" + (++n));
}

export const db = {
  prepare(sql) {
    const text = translate(sql);
    const query = async values => (context.getStore() || pool).query(text, values);
    return {
      async get(...args) { return (await query(args)).rows[0]; },
      async all(...args) { return (await query(args)).rows; },
      async run(...args) { const result = await query(args); return { changes: result.rowCount }; }
    };
  },
  async transaction(action) {
    if (context.getStore()) throw new Error("Nested PostgreSQL transaction is not supported.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await context.run(client, action);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  },
  async lockDevice(deviceId) {
    if (!context.getStore()) throw new Error("Device lock requires a transaction.");
    await db.prepare("SELECT id FROM devices WHERE id=? FOR UPDATE").get(deviceId);
  }
};

export async function applyMigrations() {
  await db.transaction(async () => {
    await db.prepare("SELECT pg_advisory_xact_lock(7482361)").get();
    await db.prepare("CREATE TABLE IF NOT EXISTS pg_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
    for (const name of fs.readdirSync(migrationDir).filter(n => n.endsWith(".sql")).sort()) {
      if (await db.prepare("SELECT name FROM pg_schema_migrations WHERE name=?").get(name)) continue;
      const sql = fs.readFileSync(path.join(migrationDir, name), "utf8");
      await (context.getStore()).query(sql);
      await db.prepare("INSERT INTO pg_schema_migrations(name) VALUES(?)").run(name);
    }
  });
}

export async function cleanupExpiredSessions() {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP").run();
}

export async function closeDatabase() { await pool.end(); }
