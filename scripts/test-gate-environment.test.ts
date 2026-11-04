import { expect, test } from "bun:test";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Spawn the real child-environment consumer with synthetic secrets, never with
// the developer's credentials. The isolated process owns all env mutations.
test.each(["ANTHROPIC_API_KEY", "anthropic_api_key", "AWS_ACCESS_KEY_ID", "aws_access_key_id"])(
	"Windows child environments scrub credentials independent of variable casing: %s",
	async key => {
		const source = `
import {buildChildEnv} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "ci-test-ts.ts")).href)};
Object.defineProperty(process, "platform", {value:"win32"});
// Keep windowsTestTempOverride on its existing-temp early return: this test
// exercises credential propagation, not filesystem drive discovery.
process.env.SystemDrive = "C:";
process.env.TEMP = ${JSON.stringify("Z:\\isolated-temp")};
for (const name of Object.keys(process.env)) {
  if (name.toLowerCase() === ${JSON.stringify(key.toLowerCase())}) delete process.env[name];
}
process.env[${JSON.stringify(key)}] = "synthetic-secret-never-forward";
const before = process.env[${JSON.stringify(key)}];
const env = buildChildEnv();
const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(`process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([name]) => name.toLowerCase() === ${JSON.stringify(key.toLowerCase())})));`)}], {env,stdout:"pipe",stderr:"pipe"});
const [code, stdout, stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
process.stdout.write(JSON.stringify({code,stderr,forwarded:JSON.parse(stdout),hostRetained:process.env[${JSON.stringify(key)}] === before}));
`;
		const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(JSON.parse(stdout)).toEqual({ code: 0, stderr: "", forwarded: [], hostRetained: true });
	},
);
