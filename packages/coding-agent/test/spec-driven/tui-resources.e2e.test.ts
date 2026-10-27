import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { collectSpecDrivenResources } from "../../src/spec-driven/resource-inventory";
import { contentText, MARKER, respond, rolePayload, type ModelRequest } from "./provider-fixture";
import { eventually, nativeDraftSnapshot, tuiTest, withTui } from "./tui-harness";

function nativeReadResult(request: ModelRequest, target: string): string {
	const call = request.messages
		.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
		.find(value => {
			if (!isRecord(value) || !isRecord(value.function) || typeof value.function.arguments !== "string")
				return false;
			if (typeof value.function.name !== "string" || value.function.name.replace(/^_/u, "") !== "read") return false;
			const args: unknown = JSON.parse(value.function.arguments);
			return isRecord(args) && args.path === target;
		});
	if (!isRecord(call) || typeof call.id !== "string") throw new Error(`No real native read call for ${target}`);
	const result = request.messages.find(message => message.role === "tool" && message.tool_call_id === call.id);
	if (!result) throw new Error(`No real native read result for ${target}`);
	return contentText(result.content);
}

for (const location of ["directory", "absent", "file", "parent-only"] as const) {
	test.skipIf(!tuiTest)(
		`ordinary TUI discovers OpenSpec only at a direct directory and scopes manual resource grants (${location})`,
		async () => {
			const { manifest: inventory } = await collectSpecDrivenResources(
				path.resolve(import.meta.dir, "../../src/spec-driven/vendor/resources"),
			);
			await withTui(
				{
					async setup(cwd) {
						if (location === "directory") await fs.mkdir(path.join(cwd, "openspec"));
						if (location === "file") await Bun.write(path.join(cwd, "openspec"), "not a directory\n");
						if (location === "parent-only") await fs.mkdir(path.join(path.dirname(cwd), "openspec"));
					},
					reply(request) {
						const reply = respond(request);
						if (reply.text !== `${MARKER}_CHAT_READY`) return reply;
						const turn = request.messages
							.filter(message => message.role === "user")
							.map(message => contentText(message.content))
							.join("\n")
							.match(/OMP_SPEC_RESOURCE_TURN (\d+)/u);
						return turn ? { text: `OMP_SPEC_RESOURCE_COMPLETE_${turn[1]}` } : reply;
					},
				},
				[120, 36],
				async ({ cwd, provider, tui, state }) => {
					const openSpec = inventory.skills.filter(skill => skill.source === "openspec");
					const ordinary = provider.requests.find(request =>
						request.messages.some(
							message =>
								message.role === "user" && contentText(message.content).endsWith("ordinary-root-beacon"),
						),
					)!;
					const ordinaryContext = ordinary.messages.map(message => contentText(message.content)).join("\n");
					for (const skill of openSpec) {
						if (location === "directory") expect(ordinaryContext).toContain(skill.name);
						else expect(ordinaryContext).not.toContain(skill.name);
						expect(ordinaryContext).not.toContain(`name: ${skill.name}`);
					}
					const ordinarySkills = new Set([
						"systematic-debugging",
						"verification-before-completion",
						"writing-skills",
					]);
					const manualOnly = inventory.skills.filter(
						skill =>
							skill.source === "jch" || (skill.source === "superpowers" && !ordinarySkills.has(skill.name)),
					);
					const deniedPaths = manualOnly.map(skill => `skill://${skill.name}:raw`);
					let previousReply = `${MARKER}_CHAT_READY`;
					let turn = 0;
					async function newBranch() {
						await tui("submit", "/new");
						await eventually(
							() => tui("text", "--full"),
							screen => screen.includes("New session started") && !screen.includes(previousReply),
						);
					}
					async function readResources(prompt: string, selectedPath: string) {
						const turnId = String(turn++);
						const turnMarker = `OMP_SPEC_RESOURCE_TURN ${turnId}`;
						const completedMarker = `OMP_SPEC_RESOURCE_COMPLETE_${turnId}`;
						const requestStart = provider.requests.length;
						await tui(
							"type",
							`${prompt}\nOMP_SPEC_MANUAL_RESOURCE ${JSON.stringify({ path: selectedPath, deniedPaths })}\n${turnMarker}`,
						);
						// A multiline input burst can absorb the trailing Enter as text. Wait
						// until its last line and caret are in the real composer before submitting.
						await eventually(
							() => nativeDraftSnapshot(tui),
							({ screen, cursor }) => {
								const lines = screen.split("\n");
								const start = lines.findLastIndex(line => line.startsWith("╭── "));
								const end = lines.findIndex((line, index) => index > start && line.startsWith("╰─"));
								return (
									start >= 0 &&
									end > start &&
									cursor.y === end - 1 &&
									cursor.x === 3 + turnMarker.length &&
									lines[cursor.y]?.startsWith(`│  ${turnMarker}`)
								);
							},
						);
						await tui("key", "press", "Enter");
						await tui("expect", "text", completedMarker, "--timeout", "30000");
						previousReply = completedMarker;
						const completed = provider.requests
							.slice(requestStart)
							.findLast(
								request =>
									(request.tools?.length ?? 0) > 0 &&
									request.messages.some(
										message => message.role === "user" && contentText(message.content).includes(turnMarker),
									),
							);
						if (!completed) throw new Error(`No completed native resource request for turn ${turnId}`);
						return completed;
					}
					for (const skill of openSpec) {
						await newBranch();
						const selectedPath = `skill://${skill.name}:raw`;
						const completed = await readResources(
							`${location === "directory" ? "请按需读取已发现的 OpenSpec 技能，不实施、不同步、不归档。" : `/skill:${skill.name}`} ${MARKER}`,
							selectedPath,
						);
						const selected = parseFrontmatter(nativeReadResult(completed, selectedPath), {
							source: selectedPath,
							repair: false,
							level: "off",
						});
						expect(selected.frontmatter.name).toBe(skill.name);
						expect(selected.frontmatter.description).toBeString();
						const denied = nativeReadResult(completed, deniedPaths.join(";"));
						for (const other of manualOnly) expect(denied).toContain(`Skill access denied: ${other.name}`);
						expect((await state()).run).toBeUndefined();
						expect(await Bun.file(path.join(cwd, ".omp/dev/state.json")).exists()).toBe(false);
					}
					// A new native branch cannot borrow the previous explicit invocation.
					if (location !== "directory") {
						await newBranch();
						const selectedPath = `skill://${openSpec[0]!.name}:raw`;
						const completed = await readResources("仅探测未授权读取。", selectedPath);
						expect(nativeReadResult(completed, selectedPath)).toContain(
							`Skill access denied: ${openSpec[0]!.name}`,
						);
					}
					expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
				},
			);
		},
		300_000,
	);
}
