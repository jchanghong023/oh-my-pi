#!/usr/bin/env bun
import {
	CNB_DEFAULT_RELEASE,
	CNB_DEFAULT_RELEASE_URL,
	CNB_RELEASE_PLATFORMS,
	CNB_TITLE_VERSION_PATTERN_PREFIX,
	CNB_TITLE_VERSION_PREFIX,
	CNB_WEB_ORIGIN,
} from "../packages/coding-agent/src/cli/cnb-release-contract";

const command = "bun scripts/cnb-generate-installers.ts";
const args = process.argv.slice(2);
const check = args[0] === "--check";
if (args.length !== (check ? 1 : 0)) throw new Error(`Usage: ${command} [--check]`);

const { linux, win32 } = CNB_RELEASE_PLATFORMS;
const host = new URL(CNB_WEB_ORIGIN).host;
const installers = {
	"install.sh": [
		`CNB_RELEASES='${CNB_DEFAULT_RELEASE_URL}'`,
		`CNB_HOST='${host}'`,
		`CNB_DEFAULT_TAG='${CNB_DEFAULT_RELEASE.tag}'`,
		`CNB_BINARY='${linux.binary}'`,
		`CNB_PLATFORM='${linux.logPlatform}'`,
		String.raw`CNB_TITLE_PATTERN='${CNB_TITLE_VERSION_PATTERN_PREFIX}v[^][]*\]$'`,
		`CNB_TITLE_OFFSET=${CNB_TITLE_VERSION_PREFIX.length}`,
	],
	"install.ps1": [
		`$CnbReleases = '${CNB_DEFAULT_RELEASE_URL}'`,
		`$CnbHost = '${host}'`,
		`$CnbDefaultTag = '${CNB_DEFAULT_RELEASE.tag}'`,
		`$BinaryName = '${win32.binary}'`,
		`$CnbPlatform = '${win32.logPlatform}'`,
		String.raw`$CnbTitlePattern = '${CNB_TITLE_VERSION_PATTERN_PREFIX}v([^][]*)\]\z'`,
	],
};

const block = /^# BEGIN GENERATED CNB CONTRACT(\r?\n)[\s\S]*?^# END GENERATED CNB CONTRACT(?=\r?$)/m;
for (const [name, constants] of Object.entries(installers)) {
	const file = Bun.file(new URL(name, import.meta.url));
	const before = await file.text();
	if (!block.test(before)) throw new Error(`${name}: missing generated CNB contract block.`);
	const after = before.replace(block, (_, newline: string) =>
		[
			"# BEGIN GENERATED CNB CONTRACT",
			`# Regenerate: ${command} (verify with --check)`,
			...constants,
			"# END GENERATED CNB CONTRACT",
		].join(newline),
	);
	if (after === before) continue;
	if (check) {
		console.error(`${name}: stale CNB contract. Run ${command}.`);
		process.exitCode = 1;
	} else {
		await Bun.write(file, after);
	}
}
