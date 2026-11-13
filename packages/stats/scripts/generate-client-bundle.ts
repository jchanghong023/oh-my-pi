#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { $ } from "bun";

const GENERATED_FILE = path.join("src", "embedded-client.generated.txt");
const DIST_CLIENT_DIR = path.join("dist", "client");

const GENERATE_FLAG = "--generate";
const RESET_FLAG = "--reset";

// `--reset` restores the checked-in state: an empty file. The runtime treats
// blank (or any non-base64) content as "no archive embedded" and builds the
// dashboard from source instead; see src/server.ts.

async function collectFiles(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectFiles(fullPath)));
		} else if (entry.isFile()) {
			files.push(fullPath);
		}
	}
	files.sort();
	return files;
}

/** Build a byte-stable gzip archive of a directory for embedding in the OMP binary. */
export async function buildArchiveBase64(dir: string): Promise<string> {
	const entries = new Map<string, Uint8Array>();
	for (const filePath of await collectFiles(dir)) {
		const relativePath = path.relative(dir, filePath).split(path.sep).join("/");
		entries.set(relativePath, await Bun.file(filePath).bytes());
	}
	return buildEmbeddedArchive(entries);
}

async function main(): Promise<void> {
	if (process.argv.includes(RESET_FLAG)) {
		await Bun.write(GENERATED_FILE, "");
		console.log(`Reset ${GENERATED_FILE}`);
		return;
	}

	if (!process.argv.includes(GENERATE_FLAG)) {
		console.log(`Skipping ${GENERATED_FILE}; pass ${GENERATE_FLAG} to build the embedded bundle`);
		return;
	}

	await $`bun run build`;
	const archiveBase64 = await buildArchiveBase64(DIST_CLIENT_DIR);
	await Bun.write(GENERATED_FILE, archiveBase64);
	console.log(`Generated ${GENERATED_FILE}`);
}

if (import.meta.main) await main();
