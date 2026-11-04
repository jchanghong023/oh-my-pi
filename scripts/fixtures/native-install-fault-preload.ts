import { spyOn } from "bun:test";
import * as fs from "node:fs/promises";

// Inject only filesystem failures. The CLI still copies, stamps, compares and
// publishes real files, and executes its own rollback/cleanup control flow.
const target = process.env.OMP_NATIVE_TEST_TARGET!;
const mode = process.env.OMP_NATIVE_TEST_MODE!;
const trace = process.env.OMP_NATIVE_TEST_TRACE!;
const rename = fs.rename.bind(fs);
const unlink = fs.unlink.bind(fs);
const appendFile = fs.appendFile.bind(fs);
let attempts = 0;
Object.defineProperty(process, "platform", { value: "win32" });
spyOn(fs, "rename").mockImplementation(async (from, to) => {
	await appendFile(trace, `rename ${String(from)} -> ${String(to)}\n`);
	if (String(to) === target && String(from).includes(".tmp.")) {
		attempts++;
		if (attempts === 1 || mode === "swap-failed" || mode === "rollback-failed") {
			throw Object.assign(new Error("fixture mapped image replacement denied"), { code: "EPERM" });
		}
	}
	if (mode === "rollback-failed" && String(from).includes(".old.")) {
		throw Object.assign(new Error("fixture rollback denied"), { code: "EACCES" });
	}
	return rename(from, to);
});
spyOn(fs, "unlink").mockImplementation(async file => {
	await appendFile(trace, `unlink ${String(file)}\n`);
	if (mode === "cleanup-locked" && String(file).includes(".old.")) {
		throw Object.assign(new Error("fixture old image still mapped"), { code: "EPERM" });
	}
	return unlink(file);
});
