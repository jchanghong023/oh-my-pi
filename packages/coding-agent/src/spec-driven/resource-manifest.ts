import versions from "./vendor/inventory.json";

export const specDrivenArchiveNames = {
	skills: "spec-driven-resources.tar.gz",
	runtime: "openspec-runtime.tar.gz",
} as const;

export type SpecDrivenArchiveKind = keyof typeof specDrivenArchiveNames;

const skillNames = {
	jch: ["big-review-scan", "big-review-verify", "jch-codebase-design", "jch-grill-me", "jch-grill-todo"],
	openspec: [
		"openspec-apply-change",
		"openspec-archive-change",
		"openspec-bulk-archive-change",
		"openspec-continue-change",
		"openspec-explore",
		"openspec-ff-change",
		"openspec-new-change",
		"openspec-onboard",
		"openspec-propose",
		"openspec-sync-specs",
		"openspec-update-change",
		"openspec-verify-change",
	],
	superpowers: [
		"brainstorming",
		"diagnosing-superpowers",
		"dispatching-parallel-agents",
		"executing-plans",
		"finishing-a-development-branch",
		"receiving-code-review",
		"requesting-code-review",
		"subagent-driven-development",
		"systematic-debugging",
		"test-driven-development",
		"using-git-worktrees",
		"using-superpowers",
		"verification-before-completion",
		"writing-plans",
		"writing-skills",
	],
};

interface BundledSkillEntry {
	source: string;
	name: string;
	path: string;
}

/** Names are reserved before opening any archive, including when a prepared asset is missing. */
export const bundledSpecDrivenSkills: ReadonlyMap<string, BundledSkillEntry> = new Map(
	Object.entries(skillNames).flatMap(([source, names]) =>
		names.map(name => [name, { source, name, path: `${source}/skills/${name}/SKILL.md` }] as const),
	),
);

export interface SpecDrivenResourceManifest {
	format: 3;
	kind: SpecDrivenArchiveKind;
	sourceFingerprint: string;
	versions: Partial<typeof versions>;
	files: readonly { path: string; sha256: string; executable: boolean }[];
}

export function resourceManifest(
	kind: SpecDrivenArchiveKind,
	sourceFingerprint: string,
	files: SpecDrivenResourceManifest["files"],
): SpecDrivenResourceManifest {
	return {
		format: 3,
		kind,
		sourceFingerprint,
		versions: kind === "runtime" ? { openspec: versions.openspec } : versions,
		files,
	};
}
