#!/usr/bin/env node

/**
 * Builds the Android debug APK with the Gradle wrapper.
 *
 * The wrapper is a shell script on Unix and a batch file on Windows, so pick
 * the matching entry point instead of relying on the caller's shell.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const result = spawnSync(isWindows ? "gradlew.bat" : "./gradlew", ["assembleDebug"], {
  cwd: path.join(root, "android"),
  stdio: "inherit",
  shell: isWindows,
});

if (result.error) {
  console.error(`Unable to start Gradle: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
