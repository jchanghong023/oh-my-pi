import {
	CNB_BINARY_NAMES,
	CNB_TITLE_VERSION_PATTERN_PREFIX,
	CNB_TITLE_VERSION_PREFIX,
	type CnbAssetName,
} from "../packages/coding-agent/src/cli/cnb-release-contract";

const number = "(?:0|[1-9][0-9]*)";
const prerelease = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const versionPattern = new RegExp(
	`^${number}\\.${number}\\.${number}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);
const annotatedVersionPattern = new RegExp(String.raw`${CNB_TITLE_VERSION_PATTERN_PREFIX}(v[^[\]]*)\]$`);

function normalizedVersion(value: string): string | undefined {
	const version = value.replace(/^v/, "");
	return versionPattern.test(version) && !/\s/.test(version) ? version : undefined;
}

export function releaseVersionFrom(raw: unknown): string {
	const version = typeof raw === "string" ? normalizedVersion(raw) : undefined;
	if (!version) throw new Error("CNB release version must be a semantic version.");
	return version;
}

/** CNB's asset API has no version field. Published installers read the shared title/tag. */
export function publicationTitle(
	release: { name: string; assets?: unknown },
	tag: string,
	version: string,
	selected: readonly CnbAssetName[],
): string | undefined {
	if (!CNB_BINARY_NAMES.some(name => selected.includes(name))) return undefined;

	const annotated = annotatedVersionPattern.exec(release.name)?.[1];
	const tagVersion = normalizedVersion(tag);
	const titleVersion = normalizedVersion(annotated ?? release.name);
	// All existing consumers enforce the shared version (including any build metadata).
	if (tagVersion && tagVersion !== version) {
		throw new Error(`Versioned CNB tag ${tag} does not match binary version v${version}.`);
	}
	if ((titleVersion ?? tagVersion) === version && (annotated === undefined || titleVersion)) return undefined;

	const unselected = CNB_BINARY_NAMES.filter(name => !selected.includes(name));
	if (!tagVersion && unselected.length) {
		const previous = release.assets;
		if (!Array.isArray(previous) ||
			previous.some(asset => !asset || typeof asset !== "object" || typeof asset.name !== "string") ||
			previous.some(asset => unselected.includes(asset.name))) {
			throw new Error(
				`Refusing to change the shared CNB version on ${tag}: ${unselected.join(", ")} would no longer match ` +
				`or its absence could not be verified. Use an existing versioned release (--tag v${version}) or select both binaries.`,
			);
		}
	}

	const label = `v${version}`;
	if (!release.name || release.name === tag || normalizedVersion(release.name)) return label;
	return `${release.name.replace(annotatedVersionPattern, "")}${CNB_TITLE_VERSION_PREFIX}${label}]`;
}
