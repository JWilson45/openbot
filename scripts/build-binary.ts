#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

const TARGETS = [
  { bunTarget: "bun-darwin-arm64", out: "openbot-darwin-arm64" },
  { bunTarget: "bun-darwin-x64", out: "openbot-darwin-x64" },
  { bunTarget: "bun-linux-x64", out: "openbot-linux-x64" },
  { bunTarget: "bun-linux-arm64", out: "openbot-linux-arm64" },
] as const;

function currentOut(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  return `openbot-${os}-${arch}`;
}

function parseWanted(): (typeof TARGETS)[number][] {
  const currentOnly = process.argv.includes("--current");
  const names = process.argv.filter((a) => a.startsWith("bun-") || a.startsWith("openbot-"));
  if (currentOnly) return TARGETS.filter((t) => t.out === currentOut());
  if (names.length > 0) {
    return names.map((n) => {
      const hit = TARGETS.find((t) => t.bunTarget === n || t.out === n);
      if (!hit) {
        console.error(`unknown target ${n}`);
        process.exit(1);
      }
      return hit;
    });
  }
  return [...TARGETS];
}

const wanted = parseWanted();
if (wanted.length === 0) {
  console.error(`no compile target for ${process.platform}/${process.arch}`);
  process.exit(1);
}

mkdirSync(DIST, { recursive: true });

for (const t of wanted) {
  const outfile = join(DIST, t.out);
  const r = Bun.spawnSync(
    [
      process.execPath,
      "build",
      join(ROOT, "apps/server/src/cli.ts"),
      "--compile",
      `--outfile=${outfile}`,
      `--target=${t.bunTarget}`,
      "--external=playwright-core",
    ],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
  console.log(`wrote ${outfile}`);
}
