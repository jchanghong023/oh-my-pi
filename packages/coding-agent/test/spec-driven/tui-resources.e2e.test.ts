import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { collectSpecDrivenResources } from "../../src/spec-driven/resource-inventory";
import { contentText, MARKER, respond, type ModelRequest } from "./provider-fixture";
import { clearNativeDraft, eventually, nativeDraftMatches, nativeDraftSnapshot, tuiTest, withTui } from "./tui-harness";

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
	test.skipIf(!tuiTest || (process.platform === "win32" && location === "absent"))(
		`ordinary TUI discovers core OpenSpec and scopes manual resource grants (${location})`,
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
				async ({ cwd, provider, tui }) => {
					const coreOpenSpec = [
						"openspec-apply-change",
						"openspec-archive-change",
						"openspec-explore",
						"openspec-propose",
						"openspec-sync-specs",
						"openspec-update-change",
					];
					const openSpec = inventory.skills.filter(
						skill => skill.source === "openspec" && coreOpenSpec.includes(skill.name),
					);
					expect(openSpec.map(skill => skill.name).sort()).toEqual(coreOpenSpec);
					const ordinary = provider.requests.find(request =>
						request.messages.some(
							message =>
								message.role === "user" && contentText(message.content).endsWith("ordinary-root-beacon"),
						),
					)!;
					const ordinaryContext = ordinary.messages.map(message => contentText(message.content)).join("\n");
					for (const skill of openSpec) {
						expect(ordinaryContext).toContain(skill.name);
						expect(ordinaryContext).not.toContain(`name: ${skill.name}`);
					}
					const superpowers = inventory.skills.filter(skill => skill.source === "superpowers");
					for (const skill of superpowers) expect(ordinaryContext).not.toContain(skill.name);
					// Exercise native completion once, including on Windows without a planning directory.
					if (location === "file") {
						const requestCount = provider.requests.length;
						for (const skill of inventory.skills.filter(skill => skill.source === "openspec")) {
							const command = `/skill:${skill.name}`;
							// The popup clips long labels at this viewport width. Only
							// require a selected skill row here; the exact unique draft
							// prefix and the completed chip below establish its identity.
							const selected = /^❯\s+(?:\S+\s+)?skill:/mu;
							await tui("type", command.slice(0, -1));
							await eventually(
								() => nativeDraftSnapshot(tui),
								({ screen, cursor }) =>
									nativeDraftMatches(screen, command.slice(0, -1), cursor) && selected.test(screen),
							);
							await tui("key", "press", "Tab");
							// Tab inserts the exact /skill:<name> command plus a space.
							// The native composer collapses that completed token into an
							// atomic skill chip; its caret stays after the trailing space.
							const completedDraft = `✦ ${skill.name}`;
							await eventually(
								() => nativeDraftSnapshot(tui),
								({ screen, cursor }) =>
									nativeDraftMatches(screen, completedDraft, cursor) &&
									cursor.x === 3 + completedDraft.length + 1,
							);
							await clearNativeDraft(tui);
						}
						expect(provider.requests).toHaveLength(requestCount);
					}
					const manualOnly = inventory.skills.filter(
						skill =>
							(skill.source === "jch" && skill.name !== "jch-codebase-design") ||
							skill.source === "superpowers" ||
							(skill.source === "openspec" && !coreOpenSpec.includes(skill.name)),
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
					async function readResources(prompt: string, selectedPath: string, denied = deniedPaths) {
						const turnId = String(turn++);
						const turnMarker = `OMP_SPEC_RESOURCE_TURN ${turnId}`;
						const completedMarker = `OMP_SPEC_RESOURCE_COMPLETE_${turnId}`;
						const requestStart = provider.requests.length;
						await tui(
							"type",
							`${prompt}\nOMP_SPEC_MANUAL_RESOURCE ${JSON.stringify({ path: selectedPath, deniedPaths: denied })}\n${turnMarker}`,
						);
						// Wait for the draft before submitting. Large pastes can be
						// represented by a chip; the provider still must see the exact turn below.
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
									((cursor.x === 3 + turnMarker.length && lines[cursor.y]?.startsWith(`│  ${turnMarker}`)) ||
										(end === start + 2 && lines[cursor.y]?.startsWith("│  📄 #")))
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
						const explicit = location === "file" && skill.name === "openspec-explore";
						const argumentsText = `${MARKER} inspect-only 参数 with spaces`;
						const completed = await readResources(
							explicit
								? `/skill:${skill.name} ${argumentsText}`
								: `请按需读取已发现的 OpenSpec 技能，不实施、不同步、不归档。 ${MARKER}`,
							selectedPath,
						);
						if (explicit) {
							const input = completed.messages
								.filter(message => message.role === "user")
								.map(message => contentText(message.content))
								.join("\n");
							expect(input).toContain(argumentsText);
							expect(input).toContain(`User invoked the "${skill.name}" skill`);
							expect(await fs.readFile(path.join(cwd, "openspec"), "utf8")).toBe("not a directory\n");
						}
						const selected = parseFrontmatter(nativeReadResult(completed, selectedPath), {
							source: selectedPath,
							repair: false,
							level: "off",
						});
						expect(selected.frontmatter.name).toBe(skill.name);
						expect(selected.frontmatter.description).toBeString();
						const denied = nativeReadResult(completed, deniedPaths.join(";"));
						for (const other of manualOnly) expect(denied).toContain(`Skill access denied: ${other.name}`);
					}
					// Explicit user invocations grant only the selected hidden packaged skill.
					for (const name of [
						"systematic-debugging",
						"brainstorming",
						...manualOnly.filter(skill => skill.source === "openspec").map(skill => skill.name),
					]) {
						await newBranch();
						const selectedPath = `skill://${name}:raw`;
						const remaining = deniedPaths.filter(target => target !== selectedPath);
						const completed = await readResources(`/skill:${name} ${MARKER}`, selectedPath, remaining);
						expect(
							parseFrontmatter(nativeReadResult(completed, selectedPath), {
								source: selectedPath,
								repair: false,
								level: "off",
							}).frontmatter.name,
						).toBe(name);
						const denied = nativeReadResult(completed, remaining.join(";"));
						for (const other of manualOnly.filter(skill => skill.name !== name))
							expect(denied).toContain(`Skill access denied: ${other.name}`);
					}
					// A new native branch cannot borrow the previous explicit invocation.
					await newBranch();
					const hiddenPath = "skill://brainstorming:raw";
					const hidden = await readResources("仅探测未授权读取。", hiddenPath);
					expect(nativeReadResult(hidden, hiddenPath)).toContain("Skill access denied: brainstorming");
				},
			);
		},
		300_000,
	);
}
