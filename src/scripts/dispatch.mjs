const command = String(process.argv[2] || "");
const allowed = new Set(["create-owner", "create-device", "change-owner-password", "rotate-device"]);
if (!allowed.has(command)) throw new Error("Unknown recovery administration command");

// Administrative scripts follow the same Neon-only policy as the API runtime.
const engine = String(process.env.JAZZ_DB_ENGINE || "postgres").trim().toLowerCase();
if (engine !== "postgres") {
  throw new Error("Unsupported JAZZ_DB_ENGINE. Jazz Recovery administration requires PostgreSQL.");
}
if (!String(process.env.DATABASE_URL || "").trim()) {
  throw new Error("PostgreSQL administration requires private DATABASE_URL.");
}

const scriptName = "pg-" + command + ".mjs";
await import("./" + scriptName);
