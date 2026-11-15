import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import groupTemplate from "../prompts/todoloop-group.md" with { type: "text" };
import scoutTemplate from "../prompts/todoloop-scout.md" with { type: "text" };
import type { TodoLoopGroup } from "./parser";

export interface TodoLoopPreviousAttempt {
	text?: string;
	error?: string;
	observation: string;
}

interface ChangeMaterials {
	proposal: string;
	design?: string;
	deltaSpecs: string[];
}

async function discoverChangeMaterials(filePath: string): Promise<ChangeMaterials | undefined> {
	const changeDirectory = path.dirname(filePath);
	const changesDirectory = path.dirname(changeDirectory);
	if (
		path.basename(filePath) !== "tasks.md" ||
		path.basename(changesDirectory) !== "changes" ||
		path.basename(path.dirname(changesDirectory)) !== "openspec"
	) {
		return undefined;
	}

	const materials: ChangeMaterials = {
		proposal: path.join(changeDirectory, "proposal.md"),
		deltaSpecs: [],
	};
	await Bun.file(materials.proposal).text();
	const designPath = path.join(changeDirectory, "design.md");
	try {
		await Bun.file(designPath).text();
		materials.design = designPath;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}

	async function collectSpecs(directory: string, optional = false): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (optional && isEnoent(error)) return;
			throw error;
		}
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const candidate = path.join(directory, entry.name);
			if (entry.name === "spec.md") {
				await Bun.file(candidate).text();
				materials.deltaSpecs.push(candidate);
			} else if (entry.isDirectory()) {
				await collectSpecs(candidate);
			}
		}
	}
	await collectSpecs(path.join(changeDirectory, "specs"), true);
	return materials;
}

/** One read-only scout assignment for all remaining groups; no conversation history. */
export async function buildTodoLoopScoutPrompt(filePath: string, cwd: string): Promise<string> {
	cwd = path.resolve(cwd);
	filePath = path.resolve(cwd, filePath);
	return prompt.render(scoutTemplate, {
		taskPackageJson: JSON.stringify({ cwd, filePath, materials: await discoverChangeMaterials(filePath) }, null, 2),
	});
}

/** File-only context seam for fresh native task dispatch; never accepts chat history. */
export async function buildTodoLoopGroupPrompt(options: {
	filePath: string;
	cwd: string;
	group: TodoLoopGroup;
	attempt: number;
	previous?: TodoLoopPreviousAttempt;
}): Promise<string> {
	const cwd = path.resolve(options.cwd);
	const filePath = path.resolve(cwd, options.filePath);
	const content = await fs.readFile(filePath, "utf8");
	const materials = await discoverChangeMaterials(filePath);
	const lines = content.split(/(?<=\n)|(?<=\r)(?!\n)/);
	return prompt.render(groupTemplate, {
		change: materials !== undefined,
		taskPackageJson: JSON.stringify(
			{
				cwd,
				filePath,
				group: {
					id: options.group.id,
					title: options.group.title,
					tasks: options.group.tasks
						.filter(task => !task.done)
						.map(task => ({
							id: task.id,
							label: task.label ?? task.id,
							raw: lines
								.slice(task.line - 1, task.line - 1 + task.text.split("\n").length)
								.join("")
								.replace(/(?:\r\n|\n|\r)$/, ""),
						})),
				},
				completedTaskIds: options.group.tasks.filter(task => task.done).map(task => task.id),
				attempt: options.attempt,
				previous: options.previous,
				materials,
			},
			null,
			2,
		),
	});
}
