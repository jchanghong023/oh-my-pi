import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Glob } from "bun";

const packageDir = path.resolve(import.meta.dir, "..");
const docsDir = path.resolve(packageDir, "../../docs");
const teamGuideDir = path.resolve(packageDir, "../../docs-zh-CN");
const teamGuideFilename = "team.md";

export interface DocsIndexPayload {
	readonly files: readonly string[];
	readonly bodies: readonly string[];
	readonly payload: string;
}

export interface DecodedDocsIndexPayload {
	readonly files: readonly string[];
	readonly bodies: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/** Build the exact two-line `omp://` docs embed from `docs/` and the Team guide. */
export async function buildDocsIndexPayload(): Promise<DocsIndexPayload> {
	const glob = new Glob("**/*.md");
	const files = [teamGuideFilename];
	for await (const relativePath of glob.scan(docsDir)) {
		if (relativePath !== teamGuideFilename) files.push(relativePath.split(path.sep).join("/"));
	}
	files.sort();

	const bodies = await Promise.all(
		files.map(file => Bun.file(path.join(file === teamGuideFilename ? teamGuideDir : docsDir, file)).text()),
	);
	const bodiesB64 = Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)), { level: 9 })).toString("base64");
	return {
		files,
		bodies,
		payload: `${JSON.stringify(files)}\n${bodiesB64}`,
	};
}

/** Decode a populated docs embed payload into filenames and index-aligned Markdown bodies. */
export function decodeDocsIndexPayload(embed: string): DecodedDocsIndexPayload | null {
	const newline = embed.indexOf("\n");
	if (newline === -1) return null;

	const filenames: unknown = JSON.parse(embed.slice(0, newline));
	if (!isStringArray(filenames)) {
		throw new Error("Embedded docs index filename line is not a JSON string array.");
	}

	const inflated = gunzipSync(Buffer.from(embed.slice(newline + 1), "base64"));
	const bodies: unknown = JSON.parse(inflated.toString("utf8"));
	if (!isStringArray(bodies)) {
		throw new Error("Embedded docs index body blob is not a JSON string array.");
	}

	return { files: filenames, bodies };
}
