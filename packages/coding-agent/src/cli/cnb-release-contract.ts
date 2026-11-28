export const CNB_WEB_ORIGIN = "https://cnb.cool";
export const CNB_DEFAULT_RELEASE = { repo: "jchanghong/bin", tag: "omp" } as const;
export const CNB_DEFAULT_UPDATE_REPOSITORY = `${CNB_DEFAULT_RELEASE.repo}@${CNB_DEFAULT_RELEASE.tag}`;

export function cnbReleasePath(repo: string): string {
	return `/${repo}/-/releases`;
}

export const CNB_DEFAULT_RELEASE_URL = `${CNB_WEB_ORIGIN}${cnbReleasePath(CNB_DEFAULT_RELEASE.repo)}`;

export const CNB_RELEASE_ARCH = "x64";
export const CNB_RELEASE_PLATFORMS = {
	win32: {
		target: `win32-${CNB_RELEASE_ARCH}`,
		logPlatform: `windows-${CNB_RELEASE_ARCH}`,
		binary: "omp-windows-x64.exe",
		sdk: "omp-sdk-win32-x64.zip",
	},
	linux: {
		target: `linux-${CNB_RELEASE_ARCH}`,
		logPlatform: `linux-${CNB_RELEASE_ARCH}`,
		binary: "omp-linux-x64",
		sdk: "omp-sdk-linux-x64.zip",
	},
} as const;

const { win32, linux } = CNB_RELEASE_PLATFORMS;
export const CNB_BINARY_NAMES = [win32.binary, linux.binary] as const;
export const CNB_ASSET_NAMES = [...CNB_BINARY_NAMES, win32.sdk, linux.sdk] as const;
export type CnbAssetName = (typeof CNB_ASSET_NAMES)[number];

// The consumers share the title marker, not their version validation policies.
export const CNB_TITLE_VERSION_PREFIX = " [omp:";
export const CNB_TITLE_VERSION_PATTERN_PREFIX = CNB_TITLE_VERSION_PREFIX.replace("[", String.raw`\[`);
