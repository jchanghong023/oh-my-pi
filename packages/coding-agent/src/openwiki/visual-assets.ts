import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isOpenWikiSourceCheckout } from "./resource-dependencies";
import { openWikiResourceFingerprint } from "./resource-fingerprint";

/** Load prebuilt browser assets; compiled binaries carry the same resource map inline. */
export async function getOpenWikiVisualAssets(): Promise<{
	clientJs: string;
	clientLibJs: string;
	stylesCss: string;
	licenseAssets: Record<string, string>;
	browserAssets: Record<string, string>;
}> {
	let serialized = process.env.PI_OPENWIKI_VISUAL_ASSETS;
	if (!serialized) {
		try {
			serialized = await readFile(
				new URL("../../dist/openwiki-resources/visual-assets.json", import.meta.url),
				"utf8",
			);
		} catch (error) {
			throw new Error(
				"OpenWiki visualizer assets are missing. Run `bun run gen:openwiki-resources` from the repository root.",
				{ cause: error },
			);
		}
	}
	let assets: Record<string, unknown>;
	try {
		assets = JSON.parse(serialized) as Record<string, unknown>;
	} catch (error) {
		throw new Error("OpenWiki visualizer assets are invalid.", { cause: error });
	}
	if (!process.env.PI_COMPILED && !process.env.PI_BUNDLED) {
		const root = fileURLToPath(new URL("../../../../", import.meta.url));
		if (isOpenWikiSourceCheckout(root)) {
			const current = openWikiResourceFingerprint(root);
			if (assets._sourceFingerprint !== current) {
				throw new Error(
					"OpenWiki visualizer assets are stale. Run `bun run gen:openwiki-resources` from the repository root.",
				);
			}
		}
	}
	const get = (name: string): string => {
		const content = assets?.[name];
		if (typeof content !== "string" || !content) {
			throw new Error(`OpenWiki visualizer asset ${name} is missing or invalid.`);
		}
		return content;
	};
	return {
		clientJs: get("client.js"),
		clientLibJs: get("client-lib.js"),
		stylesCss: get("styles.css"),
		browserAssets: Object.fromEntries(
			["force-graph.js", "marked.js", "purify.js", "mermaid.js"].map(name => [name, get(name)]),
		),
		licenseAssets: Object.fromEntries(
			Object.keys(assets)
				.filter(name => name.startsWith("licenses/"))
				.map(name => [name, get(name)]),
		),
	};
}
