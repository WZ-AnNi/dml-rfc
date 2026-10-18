#!/usr/bin/env node
/**
 * run-tests.mjs — run the whole suite and report a summary.
 *
 * `npm test` needs one place that knows every test file, so the count in the
 * README and the count in CI cannot disagree. Adding a test file here is the
 * only step needed for it to run locally and in both workflows.
 */
import { execFileSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Every `*.test.mjs` in this directory, sorted for a stable order. */
export function testFiles() {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
    .map((f) => join("scripts", f))
}

// When invoked directly, run them all.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = testFiles()
  console.log(`running ${files.length} test file(s)\n`)
  try {
    execFileSync(process.execPath, ["--test", ...files], { stdio: "inherit" })
  } catch {
    process.exit(1)
  }
}
