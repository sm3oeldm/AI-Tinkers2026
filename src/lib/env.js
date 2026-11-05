// Loads the .env file next to the given directory into process.env (without
// overriding already-set variables). Avoids a dotenv dependency for the plain
// Node custom server; `next dev`/`next build` also read the same .env natively.

const fs = require("fs");
const path = require("path");

function loadLocalEnv(dir) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(dir, ".env"), "utf8");
  } catch (e) {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

module.exports = { loadLocalEnv };
