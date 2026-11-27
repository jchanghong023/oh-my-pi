import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import nativesNotices from "@oh-my-pi/pi-natives/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import license from "../../LICENSE" with { type: "text" };
import cliNotices from "../../THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { isOpenWikiSourceCheckout } from "../openwiki/resource-dependencies";
import { openWikiResourceFingerprint } from "../openwiki/resource-fingerprint";
import { isOpenWikiArchiveStale, loadOpenWikiArchive, readOpenWikiLicenseAssets } from "../openwiki/visual-assets";

/** Render the embedded license notices in a stable display order. */
export function renderOpenWikiLicenseSections(licenses: ReadonlyMap<string, string>): string[] {
	const openWiki = licenses.get("licenses/openwiki.txt");
	return [
		openWiki ? `OpenWiki License\n\n${openWiki}` : "",
		[...licenses]
			.filter(([name]) => name.startsWith("licenses/") && name !== "licenses/openwiki.txt")
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, notice]) => notice.trimEnd())
			.join("\n\n"),
	];
}

async function openWikiNotices(): Promise<string[]> {
	const root = path.resolve(import.meta.dir, "../../../..");
	// Source images keep .gitmodules, even when they copy neither .git nor OpenWiki.
	const sourceCheckout =
		!process.env.PI_COMPILED &&
		!process.env.PI_BUNDLED &&
		(isOpenWikiSourceCheckout(root) || existsSync(path.join(root, ".gitmodules")));
	const vendorLicense = path.join(root, "vendor/openwiki/LICENSE");
	const unavailable = [
		"OpenWiki resources are unavailable. Initialize the OpenWiki submodule and run bun run gen:openwiki-resources.",
	];
	if (sourceCheckout && !existsSync(vendorLicense)) return unavailable;
	let noticeStatus = "not generated";
	try {
		const archive = await loadOpenWikiArchive();
		if (sourceCheckout && isOpenWikiArchiveStale(archive.sourceFingerprint, openWikiResourceFingerprint(root))) {
			noticeStatus = "stale";
		}
		if (noticeStatus !== "stale") {
			const sections = renderOpenWikiLicenseSections(await readOpenWikiLicenseAssets(archive.files));
			if (sections.some(section => !section))
				throw new Error("Incomplete OpenWiki license notices in the resource archive.");
			return sections;
		}
	} catch (error) {
		if (!sourceCheckout) throw error;
		// Archive or fingerprint inputs are unavailable; keep the source license when possible.
	}
	try {
		return [
			`OpenWiki License\n\n${readFileSync(vendorLicense, "utf8")}`,
			`OpenWiki browser notices are ${noticeStatus}. Run bun run gen:openwiki-resources.`,
		];
	} catch {
		return unavailable;
	}
}

/** Include OMP, OpenWiki and the notices for bundled native and browser dependencies. */
export async function formatLicenseOutput(): Promise<string> {
	const sections = [license, cliNotices, nativesNotices, ...(await openWikiNotices())].map(text => text.trimEnd());
	return `OMP License and Third-Party Notices\n\n${sections.join("\n\n")}\n`;
}
