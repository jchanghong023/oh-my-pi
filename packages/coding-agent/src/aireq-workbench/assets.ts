import * as path from "node:path";

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

export interface AIReqAssetPayload {
	schemaVersion: 1;
	manifest: AIReqAssetManifest;
	files: readonly { path: string; contentType: string; base64: string }[];
}

// Replaced by the production resource plugin; source uses the generated file only.
declare const OMP_AIREQ_WORKBENCH_ASSETS: string | undefined;
const embeddedPayload = typeof OMP_AIREQ_WORKBENCH_ASSETS === "undefined" ? null : OMP_AIREQ_WORKBENCH_ASSETS;
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Reject corrupt, obsolete-format or incomplete generated resources before serving HTML. */
export function decodeAIReqWorkbenchAssets(value: unknown): {
	manifest: AIReqAssetManifest;
	assets: ReadonlyMap<string, AIReqWorkbenchAsset>;
} {
	if (
		typeof value !== "object" ||
		value === null ||
		!("schemaVersion" in value) ||
		value.schemaVersion !== 1 ||
		!("manifest" in value) ||
		!("files" in value) ||
		!Array.isArray(value.files)
	) {
		throw new Error(`AIReq workbench assets are missing or obsolete. ${preparation}`);
	}
	const manifest = value.manifest;
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("digest" in manifest) ||
		!("sourceDigest" in manifest) ||
		!("files" in manifest) ||
		typeof manifest.digest !== "string" ||
		typeof manifest.sourceDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(manifest.sourceDigest) ||
		!Array.isArray(manifest.files)
	) {
		throw new Error(`Invalid AIReq workbench asset manifest. ${preparation}`);
	}
	const assets = new Map<string, AIReqWorkbenchAsset>();
	const files: { path: string; contentType: string; version: string }[] = [];
	const entries: readonly unknown[] = value.files;
	for (const file of entries) {
		if (
			!isRecord(file) ||
			typeof file.path !== "string" ||
			typeof file.contentType !== "string" ||
			typeof file.base64 !== "string" ||
			!validAssetPath(file.path) ||
			assets.has(file.path) ||
			!/^[\w.+-]+\/[\w.+-]+(?:; charset=utf-8)?$/.test(file.contentType)
		) {
			throw new Error(`Invalid AIReq workbench asset entry. ${preparation}`);
		}
		const bytes = Buffer.from(file.base64, "base64");
		if (bytes.toString("base64") !== file.base64) throw new Error(`Invalid asset encoding: ${file.path}`);
		assets.set(file.path, { bytes, contentType: file.contentType });
		files.push({ path: file.path, contentType: file.contentType, version: Bun.SHA256.hash(bytes, "hex") });
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	if (
		JSON.stringify(files) !== JSON.stringify(manifest.files) ||
		aiReqWorkbenchAssetDigest(files) !== manifest.digest ||
		!assets.has("/index.html") ||
		!files.some(file => file.contentType.startsWith("text/javascript"))
	) {
		throw new Error(`AIReq workbench asset payload is incomplete, stale or corrupt. ${preparation}`);
	}
	return {
		manifest: { digest: manifest.digest, sourceDigest: manifest.sourceDigest, files },
		assets,
	};
}

let loaded: Promise<{ manifest: AIReqAssetManifest; assets: ReadonlyMap<string, AIReqWorkbenchAsset> }> | undefined;

function loadAssets(): Promise<{ manifest: AIReqAssetManifest; assets: ReadonlyMap<string, AIReqWorkbenchAsset> }> {
	return (loaded ??= (async () => {
		let value: unknown;
		try {
			value =
				embeddedPayload === null
					? await Bun.file(new URL("./assets.generated.json", import.meta.url)).json()
					: JSON.parse(embeddedPayload);
		} catch (cause) {
			throw new Error(`AIReq workbench production assets are unavailable. ${preparation}`, { cause });
		}
		return decodeAIReqWorkbenchAssets(value);
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
