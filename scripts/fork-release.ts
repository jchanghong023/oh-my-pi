#!/usr/bin/env bun
import { $ } from "bun";

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`;
}

function defaultForkTag(version: string): string {
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
	return `v${version}-fork.${stamp}`;
}

function validTag(tag: string, version: string): boolean {
	const prefix = `v${version}-fork.`;
	return tag.startsWith(prefix) && /^v\d+\.\d+\.\d+-fork\.[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(tag);
}

async function main(): Promise<void> {
	const branch = (await git(["branch", "--show-current"]).text()).trim();
	if (branch !== "main") {
		console.error(`Error: must release from main (currently '${branch}')`);
		process.exit(1);
	}

	const status = (await git(["status", "--porcelain"]).text()).trim();
	if (status) {
		console.error("Error: working tree is not clean. Commit or stash changes first.");
		console.error(status);
		process.exit(1);
	}

	console.log("Checking origin/main...");
	await git(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main", "--quiet"]);
	const head = (await git(["rev-parse", "HEAD"]).text()).trim();
	const originMain = (await git(["rev-parse", "refs/remotes/origin/main"]).text()).trim();
	if (head !== originMain) {
		console.error("Error: local main must exactly match origin/main before creating a fork release.");
		console.error(`  local:  ${head}`);
		console.error(`  origin: ${originMain}`);
		process.exit(1);
	}

	const codingAgent = await Bun.file("packages/coding-agent/package.json").json();
	const version = codingAgent.version;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
		console.error(`Error: unexpected coding-agent version: ${String(version)}`);
		process.exit(1);
	}

	const requestedTag = process.argv[2];
	const tag = requestedTag ?? defaultForkTag(version);
	if (!validTag(tag, version)) {
		console.error(`Error: invalid fork release tag '${tag}'.`);
		console.error(`Expected: v${version}-fork.<id>`);
		process.exit(1);
	}

	const remoteTag = await git(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`])
		.quiet()
		.nothrow();
	if (remoteTag.exitCode === 0) {
		console.error(`Error: remote tag ${tag} already exists.`);
		process.exit(1);
	}

	console.log(`Creating fork release ${tag} from ${head.slice(0, 12)}...`);
	await git(["tag", tag, head]);
	const push = await git(["push", "origin", `${head}:refs/tags/${tag}`]).nothrow();
	if (push.exitCode !== 0) {
		await git(["tag", "-d", tag]).quiet().nothrow();
		console.error(`Error: failed to push ${tag}. Local tag was removed.`);
		process.exit(push.exitCode || 1);
	}

	console.log(`Fork release triggered: ${tag}`);
	console.log("GitHub Actions workflow: Fork Release");
}

if (import.meta.main) {
	await main();
}
