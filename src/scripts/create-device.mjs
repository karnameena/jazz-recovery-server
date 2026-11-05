import readline from "node:readline/promises";
import crypto from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { applyMigrations, db } from "../db/database.mjs";
import { hashSecret, randomToken } from "../auth/password.mjs";

applyMigrations();
const rl = readline.createInterface({ input, output });
try {
  const username = (await rl.question("Owner username: ")).trim();
  const user = db.prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE").get(username);
  if (!user) throw new Error("Owner not found. Run create-owner first.");

  const deviceId = (await rl.question("Device ID: ")).trim() || `jazz-lost-${crypto.randomUUID()}`;
  if (!/^[A-Za-z0-9._:-]{3,120}$/.test(deviceId)) throw new Error("Invalid device ID.");
  if (db.prepare("SELECT 1 FROM devices WHERE device_id=?").get(deviceId)) throw new Error("Device ID already exists.");
  const deviceName = (await rl.question("Device name [My Mobile]: ")).trim() || "My Mobile";
  const token = randomToken(32);
  const result = db.prepare("INSERT INTO devices(user_id,device_id,device_name,credential_hash) VALUES(?,?,?,?)")
    .run(user.id, deviceId, deviceName, hashSecret(token));
  db.prepare("INSERT INTO device_state(device_id) VALUES(?)").run(Number(result.lastInsertRowid));

  console.log("\nDevice enrolled.");
  console.log(`Device ID: ${deviceId}`);
  console.log(`Device credential (shown once): ${token}`);
  console.log("Store this credential only in the Android Companion Lost Mode configuration. It is stored hashed on the server.");
} finally { rl.close(); }
