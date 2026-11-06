#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const r = spawnSync(
  process.execPath,
  ["--import", tsx, join(here, "../src/cli.ts"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(r.status ?? 1);
