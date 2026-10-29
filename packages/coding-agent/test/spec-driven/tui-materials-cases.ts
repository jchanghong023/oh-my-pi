import { expect, test } from "bun:test";
import { REQUIREMENT } from "./provider-fixture";
import { clearNativeDraft, entry, expectNativeFailure, nativeTranscript, tuiTest, withTui } from "./tui-harness";

export function registerMaterialFailureTests(roles: readonly ("requirements" | "solution" | "planner" | "executor")[]) {
	for (const role of roles) {
		for (const kind of ["missing", "malformed", "unknown"] as const) {
			test.skipIf(
				!tuiTest ||
					(process.platform === "win32" &&
						((kind === "malformed" && (role === "requirements" || role === "solution")) ||
							(kind === "unknown" && (role === "requirements" || role === "solution" || role === "planner")))),
			)(
				`native TUI next preserves ${role} on ${kind} formal material and retains editor focus`,
				async () => {
					await withTui(
						{ fileFailure: { role, kind } },
						[100, 28],
						async ({ provider, tui, state, stage, idle }) => {
							await tui("submit", "/dev");
							await idle();
							await tui("submit", `/dev new ${REQUIREMENT}`);
							await stage("requirements");
							if (role !== "requirements") {
								await tui("submit", "/dev next");
								await stage("solution");
							}
							if (role === "planner" || role === "executor") {
								await tui("submit", "/dev next pure");
								await stage("planning");
							}
							if (role === "executor") {
								await tui("submit", "/dev next");
								await stage("executing");
							}
							const before = await state();
							const calls = provider.requests.length;
							const transcript = await nativeTranscript(before.run!, role);
							await tui("submit", role === "solution" ? "/dev next pure" : "/dev next");
							// Missing specs are reported against their directory, not the saved recursive glob.
							const material =
								role === "requirements"
									? kind === "malformed"
										? `openspec/changes/${before.run!.changeId}`
										: before
												.run!.paths!.requirements.find(file => file.includes("*"))!
												.split("*", 1)[0]!
												.replace(/\/$/u, "")
									: (entry(provider, role).outputPaths as string[])[0]!;
							const reason =
								kind !== "malformed"
									? role === "requirements"
										? /缺少需求规格/
										: role === "executor"
											? /缺少完成报告/
											: /ENOENT/
									: role === "requirements"
										? /Specification validation failed|Empty specification artifact/
										: role === "solution"
											? /valid JSON/
											: role === "planner"
												? /Empty specification artifact/
												: /Completion report requires/;
							await expectNativeFailure(
								tui,
								reason,
								material,
								role === "solution" ? "/dev next pure" : "/dev next",
							);
							await idle();
							expect(await state()).toEqual(before);
							expect(provider.requests).toHaveLength(calls);
							expect(await nativeTranscript(before.run!, role)).toBe(transcript);
							await clearNativeDraft(tui);
							await tui("type", `retained-${role}-${kind}-draft`);
							await tui("expect", "text", `retained-${role}-${kind}-draft`, "--timeout", "30000");
							expect(provider.requests).toHaveLength(calls);
						},
					);
				},
				180_000,
			);
		}
	}
}
