// SPDX-License-Identifier: LGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const profile = process.argv[2] === "debug" ? "debug" : "release";
const rustcOutput = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = rustcOutput.match(/^host:\s+(.+)$/m)?.[1];
const target = process.env.DPMD_STUDIO_TARGET || host;

if (!target) {
  throw new Error("Could not determine the Rust target triple");
}

const cargoArguments = ["build", "-p", "dpstudio", "--target", target];
if (profile === "release") cargoArguments.push("--release");
execFileSync("cargo", cargoArguments, { cwd: desktopDirectory, stdio: "inherit" });

const extension = target.includes("windows") ? ".exe" : "";
const source = join(desktopDirectory, "target", target, profile, `dpstudio${extension}`);
const destinationDirectory = join(desktopDirectory, "src-tauri", "binaries");
const destination = join(destinationDirectory, `dpstudio-${target}${extension}`);
mkdirSync(destinationDirectory, { recursive: true });
copyFileSync(source, destination);
process.stdout.write(`Prepared ${destination}\n`);
