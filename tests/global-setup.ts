import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export default function setup() {
  // Ensure the data dir exists so SQLite files can be created.
  const dataDir = path.resolve(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.resolve(process.cwd(), "data", "test-uploads"), { recursive: true });

  // Push the schema to the disposable test database.
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "file:../data/test.db" },
  });
}
