import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runNode(script, args, overrides = {}) {
  const env = { ...process.env, ...overrides, DATABASE_URL: "" };
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000
  });
}

test("API entrypoint refuses SQLite instead of falling back to a local database", () => {
  const result = runNode("src/entrypoint.mjs", [], { JAZZ_DB_ENGINE: "sqlite" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires PostgreSQL/i);
});

test("API entrypoint defaults to PostgreSQL and requires DATABASE_URL", () => {
  const result = runNode("src/entrypoint.mjs", [], { JAZZ_DB_ENGINE: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required/i);
});

test("administrative commands refuse SQLite and require Neon PostgreSQL", () => {
  const result = runNode("src/scripts/dispatch.mjs", ["create-owner"], { JAZZ_DB_ENGINE: "sqlite" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /administration requires PostgreSQL/i);
});
