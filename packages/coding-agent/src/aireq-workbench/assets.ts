import * as path from "node:path";
import { decodeEmbeddedArchive, extractEmbeddedArchive, hasEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import archiveText from "./assets.generated.txt";

/** Exact production bytes shared by source, npm and standalone consumers. */
export interface AIReqWorkbenchAsset {
	bytes: Uint8Array;
	contentType: string;
}

export interface AIReqAssetManifest {
	digest: string;
	sourceDigest: string;
	files: readonly { path: string; contentType: string; version: string }[];
}

const META_ENTRY = "__omp_meta__.json";
const preparation = "Run bun run gen:aireq (bun packages/coding-agent/scripts/aireq-workbench-resources.ts --write).";

/** Hash the ordered paths, MIME types and exact byte hashes without ambiguous framing. */
export function aiReqWorkbenchAssetDigest(files: AIReqAssetManifest["files"]): string {
	return Bun.SHA256.hash(JSON.stringify(files), "hex");
}

function validAssetPath(value: string): boolean {
	return (
		value.startsWith("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		value !== "/" &&
		path.posix.normalize(value) === value &&
		!value.includes("\0")
	);
}

function validContentType(value: string): boolean {
	return /^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface AIReqArchiveMeta {
	sourceDigest: string;
	files: { path: string; contentType: string }[];
}

/** Validate the archive's manifest entry before trusting any path or MIME type. */
function decodeAIReqWorkbenchMeta(value: unknown): AIReqArchiveMeta {
	if (
		!isRecord(value) ||
		typeof value.sourceDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
		!Array.isArray(value.files)
	) {
		throw new Error(`Invalid AIReq workbench archive metadata. ${preparation}`);
	}
	const seen = new Set<string>();
	const files: { path: string; contentType: string }[] = [];
	for (const file of value.files) {
		if (
			!isRecord(file) ||
			typeof file.path !== "string" ||
			typeof file.contentType !== "string" ||
			!validAssetPath(file.path) ||
			!validContentType(file.contentType) ||
			seen.has(file.path)
		) {
			throw new Error(`Invalid AIReq workbench archive entry. ${preparation}`);
		}
		seen.add(file.path);
		files.push({ path: file.path, contentType: file.contentType });
	}
	return { sourceDigest: value.sourceDigest, files };
}

/** Decode an extracted archive into exact asset bytes plus the hashed manifest. */
export async function decodeAIReqWorkbenchArchive(files: ReadonlyMap<string, Blob | File>): Promise<{
	manifest: AIReqAssetManifest;
	assets: ReadonlyMap<string, AIReqWorkbenchAsset>;
}> {
	const metaBlob = files.get(META_ENTRY);
	if (!metaBlob) throw new Error(`AIReq workbench archive is missing its metadata. ${preparation}`);
	let rawMeta: unknown;
	try {
		rawMeta = JSON.parse(await metaBlob.text());
	} catch (cause) {
		throw new Error(`AIReq workbench archive metadata is corrupt. ${preparation}`, { cause });
	}
	const meta = decodeAIReqWorkbenchMeta(rawMeta);
	const archiveEntries = new Set([...files.keys()].filter(name => name !== META_ENTRY));
	const expectedEntries = new Set(meta.files.map(file => file.path.slice(1)));
	if (archiveEntries.size !== expectedEntries.size || [...expectedEntries].some(name => !archiveEntries.has(name))) {
		throw new Error(`AIReq workbench archive entries do not match its metadata. ${preparation}`);
	}
	const assets = new Map<string, AIReqWorkbenchAsset>();
	const manifestFiles: { path: string; contentType: string; version: string }[] = [];
	for (const file of meta.files) {
		const blob = files.get(file.path.slice(1));
		if (!blob) throw new Error(`AIReq workbench archive entry is missing: ${file.path}`);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		assets.set(file.path, { bytes, contentType: file.contentType });
		manifestFiles.push({ path: file.path, contentType: file.contentType, version: Bun.SHA256.hash(bytes, "hex") });
	}
	manifestFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (!assets.has("/index.html") || !manifestFiles.some(file => file.contentType.startsWith("text/javascript")))
		throw new Error(`AIReq workbench archive is incomplete. ${preparation}`);
	return {
		manifest: {
			digest: aiReqWorkbenchAssetDigest(manifestFiles),
			sourceDigest: meta.sourceDigest,
			files: manifestFiles,
		},
		assets,
	};
}

let loaded: Promise<{ manifest: AIReqAssetManifest; assets: ReadonlyMap<string, AIReqWorkbenchAsset> }> | undefined;

function loadAssets(): Promise<{ manifest: AIReqAssetManifest; assets: ReadonlyMap<string, AIReqWorkbenchAsset> }> {
	return (loaded ??= (async () => {
		let text = archiveText;
		if (!hasEmbeddedArchive(text)) {
			try {
				text = await Bun.file(new URL("../../dist/aireq-workbench-assets.txt", import.meta.url)).text();
			} catch (cause) {
				throw new Error(`AIReq workbench production assets are unavailable. ${preparation}`, { cause });
			}
		}
		const archive = decodeEmbeddedArchive(text);
		if (!archive) throw new Error(`AIReq workbench production assets are unavailable. ${preparation}`);
		return decodeAIReqWorkbenchArchive(await extractEmbeddedArchive(archive));
	})());
}

/** No builds, checkout discovery or networking occur on this path. */
export async function getAIReqWorkbenchAsset(assetPath: string): Promise<AIReqWorkbenchAsset | null> {
	const { assets } = await loadAssets();
	const normalized = assetPath === "/" || assetPath === "/aireq-workbench.html" ? "/index.html" : assetPath;
	return assets.get(normalized) ?? null;
}

export async function getAIReqWorkbenchAssetManifest(): Promise<AIReqAssetManifest> {
	return (await loadAssets()).manifest;
}
