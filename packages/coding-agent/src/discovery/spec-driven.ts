import * as path from "node:path";
import { registerProvider } from "../capability";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { ensureSpecDrivenResources } from "../spec-driven/resources";
import { isOrdinarySuperpowersSkill, SPEC_DRIVEN_SKILL_PROVIDER } from "../spec-driven/skill-policy";
import { scanSkillsFromDir } from "./helpers";

/** Low-priority builtins use the ordinary catalog collision rules; native autoload bypasses that catalog. */
export async function loadSpecDrivenSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const resources = await ensureSpecDrivenResources();
	const items: Skill[] = [];
	const warnings: string[] = [];
	for (const entry of resources.manifest.skills) {
		if (entry.source === "superpowers" && !isOrdinarySuperpowersSkill(entry.name)) continue;
		const filePath = path.resolve(resources.root, entry.path);
		const result = await scanSkillsFromDir(ctx, {
			dir: path.dirname(filePath),
			includeSelf: true,
			providerId: SPEC_DRIVEN_SKILL_PROVIDER,
			level: "project",
			origin: `bundled-${entry.source}`,
			pluginName: entry.source,
		});
		warnings.push(...(result.warnings ?? []));
		// Only pinned manifest entries are admitted, never bootstrap hooks or unrelated sibling trees.
		for (const skill of result.items) {
			if (path.resolve(skill.path) !== filePath) continue;
			items.push({
				...skill,
				name: entry.name,
				containRoot: {
					openspec: resources.openspecRoot,
					superpowers: resources.superpowersRoot,
					jch: resources.jchRoot,
				}[entry.source],
			});
		}
	}
	return { items, warnings };
}

registerProvider<Skill>(skillCapability.id, {
	id: SPEC_DRIVEN_SKILL_PROVIDER,
	displayName: "Spec-driven resources",
	description: "Pinned OpenSpec, Superpowers and JCH skills with resource-defined discovery visibility",
	priority: 1,
	load: loadSpecDrivenSkills,
});
