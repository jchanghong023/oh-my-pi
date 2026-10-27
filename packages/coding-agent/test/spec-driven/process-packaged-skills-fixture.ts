import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, parseFrontmatter, TempDir } from "@oh-my-pi/pi-utils";
import { LegacyProtocol, v4ConversationRowsRangeResultSchema } from "../../src/modes/zcode/schema";
import inventory from "../../src/spec-driven/vendor/inventory.json";
import {
	bounded,
	fixture,
	GATE_BUDGET,
	git,
	isConversation,
	launch,
	PublicPeer,
	run,
	test,
	textValues,
	workspace,
} from "./process-fixture";
import { contentText, createProviderFixture, MARKER, rolePayload } from "./provider-fixture";

export function registerPackagedSkillTest(hasOpenSpec: boolean): void {
	test(
		`packaged skills preserve directory-scoped OpenSpec discovery and manual access (${hasOpenSpec ? "with" : "without"} openspec)`,
		async () => {
			await using root = await TempDir.create("@omp-spec-skills-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			if (hasOpenSpec) await fs.mkdir(path.join(config.cwd, "openspec"));
			const baseline = await git(config.cwd, config.env, ["rev-parse", "HEAD"]);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.ready();
			const defaultSkills: Record<string, true> = {
				"verification-before-completion": true,
				"systematic-debugging": true,
				"writing-skills": true,
			};
			if (hasOpenSpec)
				for (const entry of inventory.skills.filter(entry => entry.source === "openspec"))
					defaultSkills[entry.name] = true;
			const ordinary = await peer.create(config.cwd);
			let since = await peer.send(ordinary, `${MARKER} ordinary greeting, no skills requested`);
			await peer.next(
				frame =>
					isConversation(frame, ordinary) && textValues(frame).some(text => text.includes(`${MARKER}_CHAT_READY`)),
				since,
			);
			const ordinaryRequests = provider.requests.filter(request => (request.tools?.length ?? 0) > 0);
			expect(ordinaryRequests.length).toBeGreaterThan(0);
			for (const request of ordinaryRequests)
				for (const skill of inventory.skills) {
					expect(JSON.stringify(request.messages)).not.toContain(`/skill:${skill.name}`);
					expect(JSON.stringify(request.messages)).not.toContain(`name: ${skill.name}`);
					expect(JSON.stringify(request.messages)).not.toContain(skill.path);
				}
			const catalog = LegacyProtocol.zcodeSkillsReferenceCatalogResultSchema.parse(
				await peer.request("skills/referenceCatalog", { workspace: workspace(config.cwd), sessionId: ordinary }),
			);
			const resourceMetadata = new Map<string, { name: string; description: string }>();
			for (const entry of inventory.skills) {
				const skill = catalog.skills.find(item => item.name === entry.name);
				if (!skill) throw new Error(`Public packaged skill missing: ${entry.name}`);
				const canonical = await fs.realpath(skill.path);
				expect(path.relative(config.root, canonical).startsWith("..")).toBe(false);
				expect(canonical.replaceAll("\\", "/")).toEndWith(entry.path);
				const source = await fs.readFile(canonical, "utf8");
				const metadata = parseFrontmatter(source, { source: canonical, repair: false, level: "off" });
				if (typeof metadata.frontmatter.name !== "string" || typeof metadata.frontmatter.description !== "string")
					throw new Error(`Packaged resource lacks skill identity: ${entry.name}`);
				for (const request of ordinaryRequests) {
					const context = request.messages.map(message => contentText(message.content)).join("\n");
					if (typeof metadata.frontmatter.description === "string") {
						if (defaultSkills[entry.name]) expect(context).toContain(entry.name);
						else expect(context).not.toContain(metadata.frontmatter.description);
					}
				}
				resourceMetadata.set(entry.name, {
					name: metadata.frontmatter.name,
					description: metadata.frontmatter.description,
				});
			}
			for (const entry of inventory.skills) {
				const session = await peer.create(config.cwd);
				const requestStart = provider.requests.length;
				const selectedPath = `skill://${entry.name}:raw`;
				const allowedPaths: string[] = [];
				const others = inventory.skills.filter(other => other.name !== entry.name && !defaultSkills[other.name]);
				const deniedPaths = others.map(other => `skill://${other.name}:raw`);
				since = await peer.send(
					session,
					`${entry.source === "openspec" && hasOpenSpec ? "Use OpenSpec; read the relevant skill instructions." : `/skill:${entry.name}`} ${MARKER} capability inspection only; do not implement, archive, commit, launch servers or execute destructive scripts.\nOMP_SPEC_MANUAL_RESOURCE ${JSON.stringify({ path: selectedPath, allowedPaths, deniedPaths })}`,
				);
				await peer.next(
					frame =>
						isConversation(frame, session) &&
						textValues(frame).some(text => text.includes(`${MARKER}_CHAT_READY`)),
					since,
				);
				const requests = provider.requests.slice(requestStart).filter(request => (request.tools?.length ?? 0) > 0);
				expect(requests.length).toBeGreaterThan(0);
				// Inspect native results delivered back to the model, correlated by the
				// public provider tool-call ID. The model's final text is only a barrier.
				const completed = requests.at(-1)!;
				const published = v4ConversationRowsRangeResultSchema.parse(
					await peer.request("v4/conversation/rowsRange", { sessionId: session, limit: 100 }),
				);
				const readResult = (target: string): string => {
					const call = completed.messages
						.flatMap(message => (message.role === "assistant" ? (message.tool_calls ?? []) : []))
						.find(value => {
							if (!isRecord(value) || !isRecord(value.function)) return false;
							if (typeof value.function.arguments !== "string") return false;
							const args: unknown = JSON.parse(value.function.arguments);
							return (
								typeof value.function.name === "string" &&
								value.function.name.replace(/^_/u, "") === "read" &&
								isRecord(args) &&
								args.path === target
							);
						});
					if (!isRecord(call) || typeof call.id !== "string") throw new Error(`No native read call for ${target}`);
					const result = completed.messages.find(
						message => isRecord(message) && message.role === "tool" && message.tool_call_id === call.id,
					);
					if (!result) throw new Error(`No native read result for ${target}`);
					if (target === selectedPath || allowedPaths.includes(target)) {
						const row = published.rows.find(item => item.kind === "toolCall" && item.toolCallId === call.id);
						if (!row || row.kind !== "toolCall" || row.status !== "success")
							throw new Error(
								`Selected package read failed: ${bounded({
									resource: entry.name,
									path: target,
									status: row?.kind === "toolCall" ? row.status : "missing",
									output: contentText(result.content).slice(0, 500),
								})}`,
							);
					}
					return contentText(result.content);
				};
				const selected = parseFrontmatter(readResult(selectedPath), {
					source: selectedPath,
					repair: false,
					level: "off",
				});
				// Resource identity and usable instructions, not rendered prompt wording
				// or a copied body, establish that the real package read succeeded.
				expect(selected.frontmatter.name).toBe(resourceMetadata.get(entry.name)!.name);
				expect(typeof selected.frontmatter.description).toBe("string");
				const denied = readResult(deniedPaths.join(";"));
				const context = completed.messages.map(message => contentText(message.content)).join("\n");
				for (const other of others) {
					expect(denied).toContain(`Skill access denied: ${other.name}`);
					const description = resourceMetadata.get(other.name)?.description;
					if (typeof description === "string") expect(context).not.toContain(description);
				}
			}
			// Public packaged companion entry uses the embedded runtime and trusted launcher,
			// not a raw extracted script or a developer-machine Node installation.
			const graphDirectory = root.join("graphviz-fixture");
			await fs.mkdir(graphDirectory, { recursive: true });
			await fs.writeFile(
				path.join(graphDirectory, "SKILL.md"),
				"# Acceptance graph\n\n```dot\ndigraph acceptance { specification -> approved; }\n```\n",
			);
			const rendered = await run(config.cwd, config.env, [
				...launch,
				"superpowers",
				"skills/writing-skills/render-graphs.js",
				graphDirectory,
			]);
			const graphOutput = `${rendered.stdout}\n${rendered.stderr}`;
			const svg = Bun.file(path.join(graphDirectory, "diagrams/acceptance.svg"));
			if (rendered.exitCode === 0) {
				expect(await svg.exists()).toBe(true);
				expect(await svg.text()).toContain("<svg");
				expect(graphOutput).toContain("Rendered:");
			} else {
				expect(await svg.exists()).toBe(false);
				expect(graphOutput).toMatch(/graphviz \(dot\) not found/iu);
				expect(graphOutput).not.toContain("Rendered:");
			}
			// Missing Bash is observable through the trusted public launcher. With Bash,
			// no-argument usage is a real safe failure; never run destructive inventory probes.
			const reviewUsage = await run(config.cwd, config.env, [
				...launch,
				"superpowers",
				"skills/subagent-driven-development/scripts/review-package",
			]);
			expect(reviewUsage.exitCode).not.toBe(0);
			expect(`${reviewUsage.stdout}\n${reviewUsage.stderr}`).toMatch(/usage|require.*bash/iu);
			expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
			expect(provider.failures).toEqual([]);
			expect(await git(config.cwd, config.env, ["status", "--porcelain"])).toBe("");
			expect(await git(config.cwd, config.env, ["rev-parse", "HEAD"])).toBe(baseline);
		},
		GATE_BUDGET,
	);
}
