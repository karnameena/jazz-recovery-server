import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import pg from "pg";
import { hashSecret } from "../src/auth/password.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testUrl = process.env.JAZZ_TEST_DATABASE_URL;
const local = testUrl && ["localhost","127.0.0.1","[::1]","::1"].includes(new URL(testUrl).hostname);
const envTest = {
  ...process.env,
  DATABASE_URL: testUrl,
  JAZZ_PG_ALLOW_INSECURE_LOCALHOST: "true",
  NODE_ENV: "test"
};

async function openPort() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, "127.0.0.1", resolve));
  const p = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return p;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("private SQLite import preserves owner/device hashes and recovery API on PostgreSQL", { skip: !local, timeout: 120_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jazz-pg-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sqliteFile = path.join(dir, "fixture.db");
  const sqlite = new DatabaseSync(sqliteFile);
  try {
    sqlite.exec(fs.readFileSync(path.join(projectRoot, "migrations/001_initial.sql"), "utf8"));
    sqlite.exec(fs.readFileSync(path.join(projectRoot, "migrations/002_location_service_readback.sql"), "utf8"));
    const owner = sqlite.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)")
      .run("existing-owner", hashSecret("ExistingPassword123!"));
    const token = "fixture-" + crypto.randomBytes(24).toString("hex");
    const device = sqlite.prepare("INSERT INTO devices(user_id,device_id,device_name,credential_hash) VALUES(?,?,?,?)")
      .run(Number(owner.lastInsertRowid), "existing-phone", "Original Mobile", hashSecret(token));
    const dbId = Number(device.lastInsertRowid);
    sqlite.prepare("INSERT INTO device_state(device_id,photo_data_url,location_services_status) VALUES(?,?,?)")
      .run(dbId, "data:image/jpeg;base64,YWJj", "ON");
    const pending = crypto.randomUUID();
    sqlite.prepare("INSERT INTO recovery_commands(id,device_id,type) VALUES(?,?,?)")
      .run(pending, dbId, "ring_device");
    sqlite.close();

    const dryEnv = { ...envTest, JAZZ_SQLITE_SOURCE: sqliteFile };
    delete dryEnv.DATABASE_URL;
    const dry = spawnSync(process.execPath, ["src/scripts/import-sqlite-to-postgres.mjs"], { cwd: projectRoot, env: dryEnv, encoding: "utf8" });
    assert.equal(dry.status, 0, "SQLite dry-run failed: " + dry.stderr);
    assert.match(dry.stdout, /DRY RUN ONLY/);

    const pool = new pg.Pool({ connectionString: testUrl, ssl: false });
    t.after(async () => await pool.end());
    // Strictly local isolated CI database. Never truncate a remotely hosted DB.
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    const applyEnv = { ...envTest, JAZZ_SQLITE_SOURCE: sqliteFile, JAZZ_CONFIRM_MIGRATION: "YES" };
    const importRun = spawnSync(process.execPath, ["src/scripts/import-sqlite-to-postgres.mjs", "--apply"],
      { cwd: projectRoot, env: applyEnv, encoding: "utf8", timeout: 60_000 });
    assert.equal(importRun.status, 0, "Private import failed: " + importRun.stderr + " " + importRun.stdout);
    assert.match(importRun.stdout, /Import committed and validated/);

    const rows = await pool.query("SELECT u.username,d.device_id,d.device_name,d.credential_hash,u.password_hash FROM users u JOIN devices d ON d.user_id=u.id");
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].username, "existing-owner");
    assert.equal(rows.rows[0].device_id, "existing-phone");
    assert.equal(rows.rows[0].device_name, "Original Mobile");
    assert.ok(rows.rows[0].credential_hash.startsWith("scrypt$"));
    assert.ok(rows.rows[0].password_hash.startsWith("scrypt$"));
    const expired = await pool.query("SELECT status FROM recovery_commands WHERE id=$1", [pending]);
    assert.equal(expired.rows[0].status, "expired");
    const oldPhoto = await pool.query("SELECT photo_data_url FROM device_state");
    assert.equal(oldPhoto.rows[0].photo_data_url, "data:image/jpeg;base64,YWJj");

    const second = spawnSync(process.execPath, ["src/scripts/import-sqlite-to-postgres.mjs", "--apply"],
      { cwd: projectRoot, env: applyEnv, encoding: "utf8", timeout: 60_000 });
    assert.notEqual(second.status, 0, "Import must never overwrite populated Postgres");

    const port = await openPort();
    const base = "http://127.0.0.1:" + port;
    const app = spawn(process.execPath, ["src/entrypoint.mjs"], {
      cwd: projectRoot, env: { ...envTest, JAZZ_DB_ENGINE: "postgres", PORT: String(port),
        LOST_MODE_COOKIE_SECURE: "false", LOST_MODE_PUBLIC_ORIGINS: "http://localhost:5190" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    app.stderr.on("data", text => output += String(text));
    t.after(() => app.kill("SIGTERM"));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (app.exitCode !== null) break;
      try { if ((await fetch(base + "/health")).ok) { ready = true; break; } } catch {}
      await sleep(150);
    }
    assert.ok(ready, "Postgres backend failed to start: " + output.slice(-1000));

    async function api(method, p, body, headers = {}) {
      const res = await fetch(base + p, {
        method, headers: { "Content-Type":"application/json", ...headers },
        body: body == null ? undefined : JSON.stringify(body)
      });
      return { status: res.status, data: await res.json(), cookie: res.headers.get("set-cookie") };
    }

    const login = await api("POST", "/api/auth/login",
      {username: "EXISTING-OWNER", password: "ExistingPassword123!"});
    assert.equal(login.status, 200, "Original owner password must work unchanged");
    const cookie = login.cookie.split(";")[0];
    const sessionHeaders = { Cookie: cookie };
    const session = await api("GET", "/api/auth/session", null, sessionHeaders);
    assert.equal(session.status, 200);

    const devices = await api("GET", "/api/devices", null, sessionHeaders);
    assert.equal(devices.status, 200);
    assert.equal(devices.data.items.length, 1);
    assert.equal(devices.data.items[0].deviceId, "existing-phone");
    const id = devices.data.items[0].id;
    const deviceHeaders = {Authorization:"Bearer " + token, "X-Jazz-Lost-Device-Id": "existing-phone"};
    const hb = await api("POST", "/android/device/heartbeat", {
      deviceId:"existing-phone", mode:"NORMAL_MODE",
      status:{online:true,battery:75,charging:false,network:"WIFI",locationServices:"ON",locationServicesTimestamp:Date.now()}
    }, deviceHeaders);
    assert.equal(hb.status, 200, "Original device token should still authenticate");

    const actions = "/api/devices/" + id + "/actions";
    const [q1,q2] = await Promise.all([
      api("POST",actions,{action:"LOCATION_ENABLE"},sessionHeaders),
      api("POST",actions,{action:"LOCATION_ENABLE"},sessionHeaders)
    ]);
    assert.equal(q1.status, 202);
    assert.equal(q2.status, 202);
    assert.equal(q1.data.commandId, q2.data.commandId, "Concurrent commands must deduplicate");
    const conflict = await api("POST",actions,{action:"LOCATION_DISABLE"},sessionHeaders);
    assert.equal(conflict.status, 409);

    const [next1,next2] = await Promise.all([
      api("GET","/android/device/commands/next",null,deviceHeaders),
      api("GET","/android/device/commands/next",null,deviceHeaders)
    ]);
    const received = [next1.data.command,next2.data.command].filter(Boolean);
    assert.equal(received.length,1,"Leased command delivered to exactly one poll");
    assert.equal(received[0].id,q1.data.commandId);

    const result = await api("POST","/android/device/commands/"+q1.data.commandId+"/result",{
      deviceId:"existing-phone",result:{ok:true,confirmed:true,locationServices:"ON",timestamp:Date.now()}
    },deviceHeaders);
    assert.equal(result.status,200);
    const status=await api("GET","/api/devices/"+id+"/commands/"+q1.data.commandId,null,sessionHeaders);
    assert.equal(status.data.status,"CONFIRMED");

    const ring=await api("POST",actions,{action:"RING_DEVICE"},sessionHeaders);
    assert.equal(ring.status,202,"Existing ring feature still queues");
    const photo=await api("POST",actions,{action:"RECOVERY_PHOTO",args:{camera:"front"}},sessionHeaders);
    assert.equal(photo.status,202,"Existing photo feature still queues");
    const voiceAudio = Buffer.alloc(46);
    voiceAudio.write("RIFF",0,"ascii");voiceAudio.write("WAVE",8,"ascii");
    voiceAudio.writeUInt16LE(1,20);voiceAudio.writeUInt16LE(1,22);
    voiceAudio.writeUInt32LE(16000,24);voiceAudio.writeUInt16LE(16,34);
    const voice=await api("POST",actions,{action:"PLAY_VOICE_MESSAGE",args:{mimeType:"audio/wav",audioBase64:voiceAudio.toString("base64")}},sessionHeaders);
    assert.equal(voice.status,202,"Existing voice message still queues");

    const user2=await pool.query("INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id",["other-owner",hashSecret("OtherPassword123!")]);
    const otherLogin=await api("POST","/api/auth/login",{username:"other-owner",password:"OtherPassword123!"});
    const otherCookie={Cookie:otherLogin.cookie.split(";")[0]};
    const forbidden=await api("GET","/api/devices/"+id,null,otherCookie);
    assert.equal(forbidden.status,404,"Another owner must not see this device");
    assert.ok(user2.rows[0].id);
  } finally {
    try { sqlite.close(); } catch {}
  }
});
