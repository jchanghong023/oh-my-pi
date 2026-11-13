import { fileURLToPath } from "node:url";
import { decodeEmbeddedArchive, extractEmbeddedArchive, hasEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { isOpenWikiSourceCheckout } from "./resource-dependencies";
import { openWikiResourceFingerprint } from "./resource-fingerprint";
import generatedArchiveText from "./openwiki-resources.generated.txt";

const META_FILE = "__omp_meta__.json";
const VISUAL_PREFIX = "visual/";
const VISUAL_ASSET_NAMES = ["force-graph.js", "marked.js", "purify.js", "mermaid.js"] as const;

export interface OpenWikiArchive {
	files: ReadonlyMap<string, File>;
	sourceFingerprint: string;
}

export interface OpenWikiVisualAssets {
	clientJs: string;
	clientLibJs: string;
	stylesCss: string;
	licenseAssets: Record<string, string>;
	browserAssets: Record<string, string>;
}

let archive: Promise<OpenWikiArchive> | undefined;

/** Share one lazily decoded archive between the visualizer and license command. */
export function loadOpenWikiArchive(): Promise<OpenWikiArchive> {
	return (archive ??= readOpenWikiArchive());
}

async function readOpenWikiArchive(): Promise<OpenWikiArchive> {
	let text = generatedArchiveText;
	if (!hasEmbeddedArchive(text)) {
		try {
			text = await Bun.file(new URL("../../dist/openwiki-resources.generated.txt", import.meta.url)).text();
		} catch (cause) {
			throw new Error(
				"OpenWiki resources are missing. Run `bun run gen:openwiki-resources` from the repository root.",
				{ cause },
			);
		}
	}
	const bytes = decodeEmbeddedArchive(text);
	if (bytes === null) {
		throw new Error("OpenWiki resources are missing. Run `bun run gen:openwiki-resources` from the repository root.");
	}
	let files: Map<string, File>;
	try {
		files = await extractEmbeddedArchive(bytes);
	} catch (error) {
		throw new Error(
			"OpenWiki resources are invalid. Run `bun run gen:openwiki-resources` from the repository root.",
			{ cause: error },
		);
	}
	const meta = files.get(META_FILE);
	files.delete(META_FILE);
	let sourceFingerprint: string | undefined;
	if (meta) {
		try {
			const parsed = JSON.parse(await meta.text()) as { sourceFingerprint?: unknown };
			if (typeof parsed.sourceFingerprint === "string") sourceFingerprint = parsed.sourceFingerprint;
		} catch {
			// A corrupt meta entry is reported as missing below.
		}
	}
	if (!sourceFingerprint) {
		throw new Error("OpenWiki resources are invalid. Run `bun run gen:openwiki-resources` from the repository root.");
	}
	return { files, sourceFingerprint };
}

/** A source checkout must regenerate whenever its inputs drift from the embedded fingerprint. */
export function isOpenWikiArchiveStale(sourceFingerprint: string, currentFingerprint: string | undefined): boolean {
	return currentFingerprint !== undefined && sourceFingerprint !== currentFingerprint;
}

/** Reject embedded assets whose fingerprint no longer matches the current checkout. */
export function assertOpenWikiArchiveFresh(sourceFingerprint: string, currentFingerprint: string | undefined): void {
	if (!isOpenWikiArchiveStale(sourceFingerprint, currentFingerprint)) return;
	throw new Error(
		"OpenWiki visualizer assets are stale. Run `bun run gen:openwiki-resources` from the repository root.",
	);
}

async function readVisualAsset(files: ReadonlyMap<string, File>, name: string): Promise<string> {
	const file = files.get(`${VISUAL_PREFIX}${name}`);
	const content = file ? await file.text() : "";
	if (!content) throw new Error(`OpenWiki visualizer asset ${name} is missing or invalid.`);
	return content;
}

/** Read the licenses bundled with the browser assets, keyed by their archive-relative name. */
export async function readOpenWikiLicenseAssets(files: ReadonlyMap<string, File>): Promise<Map<string, string>> {
	const licenses = new Map<string, string>();
	for (const name of [...files.keys()].filter(name => name.startsWith(`${VISUAL_PREFIX}licenses/`)).sort()) {
		const relative = name.slice(VISUAL_PREFIX.length);
		licenses.set(relative, await readVisualAsset(files, relative));
	}
	return licenses;
}

/** Render the visualizer payload from an already extracted archive. */
export async function renderOpenWikiVisualAssets(files: ReadonlyMap<string, File>): Promise<OpenWikiVisualAssets> {
	const licenseAssets = Object.fromEntries(await readOpenWikiLicenseAssets(files));
	const browserAssets: Record<string, string> = {};
	for (const name of VISUAL_ASSET_NAMES) browserAssets[name] = await readVisualAsset(files, name);
	return {
		clientJs: await readVisualAsset(files, "client.js"),
		clientLibJs: await readVisualAsset(files, "client-lib.js"),
		stylesCss: await readVisualAsset(files, "styles.css"),
		licenseAssets,
		browserAssets,
	};
}

/** Load prebuilt browser assets from the embedded archive, guarding source checkouts. */
export async function getOpenWikiVisualAssets(): Promise<OpenWikiVisualAssets> {
	const { files, sourceFingerprint } = await loadOpenWikiArchive();
	if (!process.env.PI_COMPILED && !process.env.PI_BUNDLED) {
		const root = fileURLToPath(new URL("../../../../", import.meta.url));
		if (isOpenWikiSourceCheckout(root)) {
			assertOpenWikiArchiveFresh(sourceFingerprint, openWikiResourceFingerprint(root));
		}
	}
	return renderOpenWikiVisualAssets(files);
}
