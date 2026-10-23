import { applyMigrations, closeDatabase } from "./database.mjs";
try {
  await applyMigrations();
  console.log("PostgreSQL schema migrations applied.");
} finally {
  await closeDatabase();
}
