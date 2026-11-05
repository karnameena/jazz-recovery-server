// Load a private local .env file for npm scripts. Platform-injected environment
// variables always take precedence; missing .env is normal in hosted deployments.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(serverRoot, ".env");
if (fs.existsSync(envFile)) {
  const source = fs.readFileSync(envFile, "utf8");
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (match[2].trim().startsWith('"')) value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[match[1]] = value;
  }
}
