import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv.includes("--remote") ? "--remote" : "--local";
const persistence = process.argv.find((argument) => argument.startsWith("--persist-to="))?.slice("--persist-to=".length);
const sql = await readFile(new URL("../seed/initial.sql", import.meta.url), "utf8");
const statements = splitSqlStatements(sql);
const chunks = [];
let current = "";
for (const statement of statements) {
  if (current && current.length + statement.length + 2 > 80_000) {
    chunks.push(current);
    current = "";
  }
  current += `${statement};\n`;
}
if (current) chunks.push(current);

const directory = await mkdtemp(join(tmpdir(), "frj-d1-seed-"));
try {
  for (let index = 0; index < chunks.length; index += 1) {
    const file = join(directory, `seed-${String(index + 1).padStart(3, "0")}.sql`);
    await writeFile(file, chunks[index], "utf8");
    const argumentsList = ["d1", "execute", "frj-for-sale", mode, "--file", file];
    if (persistence && mode === "--local") argumentsList.push("--persist-to", persistence);
    const wranglerEntry = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
    const result = spawnSync(process.execPath, [wranglerEntry, ...argumentsList], {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit"
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  console.log(`Seed chargé en ${chunks.length} blocs (${mode.slice(2)}).`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function splitSqlStatements(source) {
  const result = [];
  let statement = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'") {
      if (quoted && source[index + 1] === "'") {
        statement += "''";
        index += 1;
        continue;
      }
      quoted = !quoted;
    }
    if (character === ";" && !quoted) {
      if (statement.trim()) result.push(statement.trim());
      statement = "";
    } else {
      statement += character;
    }
  }
  if (statement.trim()) result.push(statement.trim());
  return result;
}
