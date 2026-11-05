const command = String(process.argv[2] || "");
const allowed = new Set(["create-owner", "create-device", "change-owner-password", "rotate-device", "recover-billing-admin"]);
if (!allowed.has(command)) throw new Error("Unknown recovery administration command");
const engine = String(process.env.JAZZ_DB_ENGINE || "sqlite").toLowerCase();
if (command === "recover-billing-admin" && engine !== "postgres") {
  throw new Error("Billing-admin recovery is PostgreSQL-only. Set JAZZ_DB_ENGINE=postgres and DATABASE_URL.");
}
if (!["sqlite", "postgres"].includes(engine)) throw new Error("Unsupported JAZZ_DB_ENGINE");
if (engine === "postgres" && !process.env.DATABASE_URL) {
  throw new Error("PostgreSQL administration requires private DATABASE_URL");
}
const scriptName = (engine === "postgres" ? "pg-" : "") + command + ".mjs";
await import("./" + scriptName);
