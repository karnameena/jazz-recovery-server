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

async function runAdmin(command, prompts) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/scripts/dispatch.mjs", command], {
      cwd: projectRoot, env: { ...envTest, JAZZ_DB_ENGINE: "postgres" },
      stdio: ["pipe","pipe","pipe"]
    });
    let out = "", err = "", index = 0;
    const watchdog = setTimeout(() => { child.kill(); reject(new Error("Timed out waiting for admin command")); }, 25_000);
    child.stdout.on("data", text => {
      out += String(text);
      while (index < prompts.length && out.includes(prompts[index][0])) {
        child.stdin.write(prompts[index][1] + "\n");
        index++;
      }
    });
    child.stderr.on("data", text => err += String(text));
    child.on("error", error => { clearTimeout(watchdog); reject(error); });
    child.on("close", code => { clearTimeout(watchdog); resolve({ code, out, err, answered: index }); });
  });
}

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

    // The existing npm admin commands must target PostgreSQL when enabled,
    // including enrolling multiple devices under the SAME owner username.
    const enrolled = await runAdmin("create-device", [
      ["Owner username:", "existing-owner"],
      ["Device ID:", "jazz-tablet-01"],
      ["Device name [My Mobile]:", "My Tablet"]
    ]);
    assert.equal(enrolled.code, 0, "PostgreSQL device enrollment failed: " + enrolled.err);
    const deviceToken = enrolled.out.match(/Device credential \(shown once\): (\S+)/)?.[1];
    assert.ok(deviceToken, "Device enrollment token not returned once");
    assert.notEqual(deviceToken, token, "Devices must have distinct credentials");
    const ownerDevices = await api("GET", "/api/devices", null, sessionHeaders);
    assert.equal(ownerDevices.data.items.length, 2, "One owner may manage multiple devices");
    const tabletAuth = {Authorization: "Bearer " + deviceToken, "X-Jazz-Lost-Device-Id": "jazz-tablet-01"};
    const tabletHeartbeat = await api("POST","/android/device/heartbeat",{
      deviceId:"jazz-tablet-01",mode:"NORMAL_MODE",status:{battery:63,network:"WIFI"}
    },tabletAuth);
    assert.equal(tabletHeartbeat.status,200,"Tablet credential must authenticate independently");

    const rotate = await runAdmin("rotate-device", [
      ["Owner username:", "existing-owner"],
      ["Existing Device ID:", "jazz-tablet-01"]
    ]);
    assert.equal(rotate.code,0,"Device credential rotation failed: " + rotate.err);
    const rotatedToken = rotate.out.match(/NEW device credential \(shown once\): (\S+)/)?.[1];
    assert.ok(rotatedToken);
    assert.notEqual(rotatedToken, deviceToken);
    const oldAuth = await api("POST","/android/device/heartbeat",{
      deviceId:"jazz-tablet-01",status:{battery:63}
    },tabletAuth);
    assert.equal(oldAuth.status,401,"Old device token must be invalidated by rotation");
    const newAuth = await api("POST","/android/device/heartbeat",{
      deviceId:"jazz-tablet-01",status:{battery:63}
    },{Authorization:"Bearer "+rotatedToken,"X-Jazz-Lost-Device-Id":"jazz-tablet-01"});
    assert.equal(newAuth.status,200,"Rotated token must authenticate");

    const created = await runAdmin("create-owner",[
      ["Lost Mode username:", "new-owner"],
      ["Password:", "BrandNewPassword123!"],
      ["Confirm password:", "BrandNewPassword123!"]
    ]);
    assert.equal(created.code,0,"PostgreSQL owner creation failed: " + created.err);
    const newOwnerLogin = await api("POST","/api/auth/login",{
      username:"new-owner",password:"BrandNewPassword123!"
    });
    assert.equal(newOwnerLogin.status,200);

    const recoveryToken = crypto.randomBytes(32).toString("base64url");
    const registration = await api("POST", "/api/auth/register", {
      username: "recovery-owner",
      password: "RecoveryOwner123!",
      confirmPassword: "RecoveryOwner123!",
      deviceName: "Recovery Test Phone",
      imei: "123456789012345",
      deviceId: "jazz-recovery-test",
      deviceToken: recoveryToken,
      recoveryPin: "2580",
      confirmRecoveryPin: "2580"
    });
    assert.equal(registration.status, 201, "Owner registration should create account and pair device");
    assert.equal(registration.data.device.imei, "123456789012345");
    const registeredCookie = { Cookie: registration.cookie.split(";")[0] };
    const registeredDevices = await api("GET", "/api/devices", null, registeredCookie);
    assert.equal(registeredDevices.data.items.length, 1);
    assert.equal(registeredDevices.data.items[0].deviceId, "jazz-recovery-test");
    assert.equal(registeredDevices.data.items[0].imei, "123456789012345");
    const registeredHeartbeat = await api("POST", "/android/device/heartbeat", {
      deviceId: "jazz-recovery-test", mode: "NORMAL_MODE", status: { battery: 78, network: "WIFI" }
    }, { Authorization: "Bearer " + recoveryToken, "X-Jazz-Lost-Device-Id": "jazz-recovery-test" });
    assert.equal(registeredHeartbeat.status, 200, "New device token must authenticate after enrollment");
    const duplicateRegistration = await api("POST", "/api/auth/register", {
      username: "recovery-owner",
      password: "RecoveryOwner123!",
      confirmPassword: "RecoveryOwner123!",
      deviceName: "Another Phone",
      imei: "123456789012345",
      deviceId: "jazz-recovery-duplicate",
      deviceToken: crypto.randomBytes(32).toString("base64url"),
      recoveryPin: "2580",
      confirmRecoveryPin: "2580"
    });
    assert.equal(duplicateRegistration.status, 409, "Duplicate owner usernames must be rejected");

    const rejectedReset = await api("POST", "/api/auth/forgot-password", {
      username: "recovery-owner",
      recoveryPin: "0000",
      newPassword: "ResetRecovery123!"
    });
    assert.equal(rejectedReset.status, 400, "An incorrect recovery PIN must not reset the password");
    const passwordReset = await api("POST", "/api/auth/forgot-password", {
      username: "recovery-owner",
      recoveryPin: "2580",
      newPassword: "ResetRecovery123!"
    });
    assert.equal(passwordReset.status, 200, "Correct recovery PIN should allow a password reset");
    assert.equal((await api("POST", "/api/auth/login", {
      username: "recovery-owner", password: "RecoveryOwner123!"
    })).status, 401, "Old password must stop working after reset");
    assert.equal((await api("POST", "/api/auth/login", {
      username: "recovery-owner", password: "ResetRecovery123!"
    })).status, 200, "New password should work after reset");
    assert.equal((await api("GET", "/api/devices", null, registeredCookie)).status, 401,
      "Password reset must invalidate existing browser sessions");

    const loginAfterReset = await api("POST", "/api/auth/login", {
      username: "recovery-owner", password: "ResetRecovery123!"
    });
    assert.equal(loginAfterReset.status, 200);
    const postResetCookie = { Cookie: loginAfterReset.cookie.split(";")[0] };

    const passkeyRegistrationOptions = await api("POST", "/api/auth/passkey/register/options", {}, postResetCookie);
    assert.equal(passkeyRegistrationOptions.status, 200, "Authenticated owner should be able to start passkey enrollment");
    assert.ok(passkeyRegistrationOptions.data.flowId);
    assert.ok(passkeyRegistrationOptions.data.options?.challenge);
    const persistedChallenges = await pool.query(
      "SELECT COUNT(*)::int AS n FROM passkey_challenges WHERE user_id=(SELECT id FROM users WHERE username='recovery-owner') AND kind='register'"
    );
    assert.equal(persistedChallenges.rows[0].n, 1, "Passkey challenge must be stored in PostgreSQL");

    const passkeyResetOptions = await api("POST", "/api/auth/password-reset/passkey/options", {
      username: "recovery-owner"
    });
    assert.equal(passkeyResetOptions.status, 200);
    assert.equal(passkeyResetOptions.data.available, false, "Account without a passkey should receive the PIN fallback");
    const legacyPasskeyOptions = await api("POST", "/api/auth/passkey/options", {
      username: "recovery-owner"
    });
    assert.equal(legacyPasskeyOptions.status, 200, "Legacy passkey-options endpoint should remain compatible");

    const repairedToken = crypto.randomBytes(32).toString("base64url");
    const repair = await api("POST", "/api/auth/device-repair", {
      username: "recovery-owner",
      password: "ResetRecovery123!",
      deviceId: "jazz-recovery-test",
      deviceToken: repairedToken,
      deviceName: "Recovered Test Phone",
      imei: "123456789012345"
    });
    assert.equal(repair.status, 200, "Authenticated repair must update the existing paired device without deleting its state");
    const oldDeviceToken = await api("POST", "/android/device/heartbeat", {
      deviceId: "jazz-recovery-test", status: { battery: 78 }
    }, { Authorization: "Bearer " + recoveryToken, "X-Jazz-Lost-Device-Id": "jazz-recovery-test" });
    assert.equal(oldDeviceToken.status, 401, "Device repair must invalidate the old token");
    const repairedDeviceToken = await api("POST", "/android/device/heartbeat", {
      deviceId: "jazz-recovery-test", status: { battery: 77 }
    }, { Authorization: "Bearer " + repairedToken, "X-Jazz-Lost-Device-Id": "jazz-recovery-test" });
    assert.equal(repairedDeviceToken.status, 200, "Repaired device token must authenticate");
    const preservedState = await pool.query(
      "SELECT device_name,imei FROM devices WHERE device_id=$1",
      ["jazz-recovery-test"]
    );
    assert.equal(preservedState.rows[0].device_name, "Recovered Test Phone");
    assert.equal(preservedState.rows[0].imei, "123456789012345");
    const stillPaired = await api("GET", "/api/devices", null, postResetCookie);
    assert.equal(stillPaired.status, 200);
    assert.equal(stillPaired.data.items.length, 1, "Repair must preserve the existing device record and history");

    const changed = await runAdmin("change-owner-password",[
      ["Lost Mode username:", "new-owner"],
      ["New password:", "ReplacedPassword123!"],
      ["Confirm new password:", "ReplacedPassword123!"]
    ]);
    assert.equal(changed.code,0,"PostgreSQL password change failed: " + changed.err);
    assert.equal((await api("POST","/api/auth/login",{
      username:"new-owner",password:"BrandNewPassword123!"
    })).status,401);
    assert.equal((await api("POST","/api/auth/login",{
      username:"new-owner",password:"ReplacedPassword123!"
    })).status,200);
  } finally {
    try { sqlite.close(); } catch {}
  }
});
