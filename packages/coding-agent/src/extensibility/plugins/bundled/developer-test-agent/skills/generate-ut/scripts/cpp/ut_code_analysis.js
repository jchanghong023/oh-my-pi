#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const python = process.platform === "win32" ? "python" : "python3";
const helper = join(__dirname, "extract-function-callees.py");
const result = spawnSync(python, [helper, "--context", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) {
	console.error(`Cannot start ${python}: ${result.error.message}`);
} else if (result.signal) {
	console.error(`C/C++ context extraction terminated by ${result.signal}`);
}
process.exitCode = result.status ?? 1;
