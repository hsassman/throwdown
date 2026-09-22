#!/usr/bin/env node
/**
 * Headless Blender pipeline runner.
 *
 *   node blender/run.mjs                 # every step, in order
 *   node blender/run.mjs 00 01 02        # just those steps
 *   node blender/run.mjs all --ship      # everything, and overwrite the live asset
 *   node blender/run.mjs --blender "C:/path/to/blender.exe"
 *
 * One command, so nobody has to remember Blender's argument order. In
 * particular the `--` separator, which Blender needs before script arguments
 * and silently swallows if you forget it.
 *
 * Steps run in separate Blender processes on purpose. Each one opens
 * out/boxer.blend, changes it, and saves. A crash in step 5 therefore leaves
 * steps 1-4 intact on disk, and any step can be re-run alone while iterating.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, "scripts");

/** Common install locations, newest first. Checked in order. */
const CANDIDATES = [
  process.env.BLENDER,
  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe",
  "C:/Program Files/Blender Foundation/Blender 4.2/blender.exe",
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/usr/bin/blender",
  "/usr/local/bin/blender",
].filter(Boolean);

function findBlender(override) {
  if (override) {
    if (!existsSync(override)) die(`no Blender at ${override}`);
    return override;
  }
  for (const c of CANDIDATES) if (existsSync(c)) return c;
  // Fall back to path.
  const probe = spawnSync("blender", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "blender";
  die(
    "Blender not found. Pass --blender <path>, or set the BLENDER environment variable."
  );
}

function die(msg) {
  console.error(`run.mjs: ${msg}`);
  process.exit(1);
}

/** All NN_*.py scripts, ordered by their numeric prefix. */
function allSteps() {
  return readdirSync(SCRIPTS)
    .filter((f) => /^\d\d_.*\.py$/.test(f))
    .sort();
}

function main() {
  const argv = process.argv.slice(2);

  let blenderOverride = null;
  const bi = argv.indexOf("--blender");
  if (bi >= 0) {
    blenderOverride = argv[bi + 1];
    argv.splice(bi, 2);
  }

  // Anything after the first `--`-prefixed flag is passed through to the
  // Python scripts (e.g. --ship, which 07_export.py reads).
  const passthrough = argv.filter((a) => a.startsWith("--"));
  const wanted = argv.filter((a) => !a.startsWith("--") && a !== "all");

  const blender = findBlender(blenderOverride);
  const steps = allSteps();
  if (!steps.length) die(`no step scripts found in ${SCRIPTS}`);

  const chosen = wanted.length
    ? wanted.map((w) => {
        const hit = steps.find((s) => s.startsWith(w.padStart(2, "0")) || s === w);
        if (!hit) die(`no step matching "${w}". Available: ${steps.join(", ")}`);
        return hit;
      })
    : steps;

  console.log(`blender: ${blender}`);
  console.log(`steps:   ${chosen.join(" -> ")}`);
  if (passthrough.length) console.log(`args:    ${passthrough.join(" ")}`);
  console.log("");

  for (const step of chosen) {
    const script = resolve(SCRIPTS, step);
    console.log(`\n=== ${step} ${"=".repeat(Math.max(0, 56 - step.length))}`);
    const args = ["--background", "--python", script];
    if (passthrough.length) args.push("--", ...passthrough);

    const res = spawnSync(blender, args, { stdio: "inherit" });
    if (res.error) die(`failed to launch Blender: ${res.error.message}`);
    if (res.status !== 0) {
      // Stop rather than carry on: every later step opens the file this one
      // was supposed to have written, so continuing just produces a confusing
      // second failure that hides the first.
      die(`${step} exited ${res.status}. Stopping.`);
    }
  }

  console.log("\nAll steps completed.");
}

main();
