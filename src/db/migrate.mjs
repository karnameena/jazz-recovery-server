import { applyMigrations, databasePath } from "./database.mjs";

applyMigrations();
console.log(`[Jazz Lost Mode] migrations applied: ${databasePath()}`);
