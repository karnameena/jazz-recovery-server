import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { applyMigrations, db } from "../db/database.mjs";
import { hashSecret, validatePassword } from "../auth/password.mjs";

applyMigrations();

async function hiddenQuestion(prompt) {
  output.write(prompt);
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output });
    try { return await rl.question(""); } finally { rl.close(); }
  }
  return await new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");
    };
    const onData = chunk => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") { cleanup(); reject(new Error("Cancelled.")); return; }
        if (char === "\r" || char === "\n") { cleanup(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char >= " ") value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

const rl = readline.createInterface({ input, output });
try {
  const username = (await rl.question("Lost Mode username: ")).trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new Error("Username must be 3-40 characters and use letters, numbers, dot, underscore or dash.");
  if (db.prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE").get(username)) throw new Error("That username already exists.");
  rl.pause();

  const password = await hiddenQuestion("Password: ");
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  const confirm = await hiddenQuestion("Confirm password: ");
  if (password !== confirm) throw new Error("Passwords do not match.");

  db.prepare("INSERT INTO users(username,password_hash) VALUES(?,?)").run(username, hashSecret(password));
  console.log("Owner created. Plaintext password was never logged and only the scrypt hash was stored.");
} finally {
  try { rl.close(); } catch {}
}
