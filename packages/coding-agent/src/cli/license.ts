import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import nativesNotices from "@oh-my-pi/pi-natives/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import license from "../../LICENSE" with { type: "text" };
import cliNotices from "../../THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { isOpenWikiSourceCheckout } from "../openwiki/resource-dependencies";
import { openWikiResourceFingerprint } from "../openwiki/resource-fingerprint";

function openWikiNotices(): string[] {
	let encoded = process.env.PI_OPENWIKI_VISUAL_ASSETS;
	if (encoded === undefined) {
		try {
			encoded = readFileSync(
				path.resolve(import.meta.dir, "../../dist/openwiki-resources/visual-assets.json"),
				"utf8",
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			try {
				return [
					`OpenWiki License\n\n${readFileSync(path.resolve(import.meta.dir, "../../../../vendor/openwiki/LICENSE"), "utf8")}`,
					"OpenWiki browser notices are not generated. Run bun run gen:openwiki-resources.",
				];
			} catch (licenseError) {
				if ((licenseError as NodeJS.ErrnoException).code !== "ENOENT") throw licenseError;
				return [
					"OpenWiki resources are unavailable. Initialize the OpenWiki submodule and run bun run gen:openwiki-resources.",
				];
			}
		}
	}
	const assets = JSON.parse(encoded) as Record<string, string>;
	if (!process.env.PI_COMPILED && !process.env.PI_BUNDLED) {
		const root = path.resolve(import.meta.dir, "../../../..");
		if (isOpenWikiSourceCheckout(root)) {
			const vendorLicense = path.join(root, "vendor/openwiki/LICENSE");
			if (!existsSync(vendorLicense)) {
				return [
					"OpenWiki resources are unavailable. Initialize the OpenWiki submodule and run bun run gen:openwiki-resources.",
				];
			}
			if (assets._sourceFingerprint !== openWikiResourceFingerprint(root)) {
				return [
					`OpenWiki License\n\n${readFileSync(vendorLicense, "utf8")}`,
					"OpenWiki browser notices are stale. Run bun run gen:openwiki-resources.",
				];
			}
		}
	}
	return [
		assets["licenses/openwiki.txt"] ? `OpenWiki License\n\n${assets["licenses/openwiki.txt"]}` : "",
		Object.entries(assets)
			.filter(([name]) => name.startsWith("licenses/") && name !== "licenses/openwiki.txt")
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, notice]) => notice.trimEnd())
			.join("\n\n"),
	];
}

/** Include OMP, OpenWiki and the notices for bundled native and browser dependencies. */
export function formatLicenseOutput(): string {
	const sections = [license, cliNotices, nativesNotices, ...openWikiNotices()].map(text => text.trimEnd());
	return `OMP License and Third-Party Notices\n\n${sections.join("\n\n")}\n`;
}
