import { expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	continuationText,
	MARKER,
	REQUIREMENT,
	respond,
	rolePayload,
	teamStage,
	type ModelRequest,
} from "./provider-fixture";
import {
	clearNativeDraft,
	eventually,
	expectNativeFailure,
	nativeDraftMatches,
	nativeDraftSnapshot,
	nativeMessageEntries,
	nativeTranscript,
	stageContexts,
	tuiTest,
	userTexts,
	withTui,
} from "./tui-harness";

test.skipIf(!tuiTest)(
	"requirements native attachment and followup queue retain exact input without handoff replay",
	async () => {
		const release = Promise.withResolvers<void>();
		let held = false;
		await withTui(
			{
				async delay(request, signal) {
					if (continuationText(request) !== "held-native-dialogue" || held) return;
					held = true;
					await Promise.race([
						release.promise,
						new Promise<void>((_, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						}),
					]);
				},
			},
			[100, 28],
			async ({ cwd, provider, tui, state, idle, stage }) => {
				const image = path.join(cwd, "requirement.png");
				await Bun.write(
					image,
					Buffer.from(
						"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=",
						"base64",
					),
				);
				await tui("submit", "/dev");
				await idle();
				const calls = provider.requests.length;
				// Raw PTY bracketed paste uses the real editor's file-image attachment path.
				await tui("write", `\u001b[200~${image}\u001b[201~`);
				await tui("expect", "text", "#[0-9]+", "--regex", "--timeout", "30000");
				await tui("type", "unclaimed-image-draft");
				await tui("key", "press", "Enter");
				await tui("expect", "text", "当前无阶段 Agent", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				await tui("expect", "text", "#[0-9]+", "--regex", "--timeout", "30000");
				expect(await tui("text")).toContain("unclaimed-image-draft");
				// Keep the rejected draft's inline image token: clearing the draft
				// intentionally deletes the attachment under the native composer contract.
				await tui("key", "press", "Home");
				await tui("type", `/dev new ${REQUIREMENT} `);
				await tui("key", "press", "Enter");
				const requirements = (await stage("requirements")).run!;
				const initial = provider.requests.find(request => rolePayload(request)?.specDrivenRole === "requirements")!;
				expect(
					initial.messages
						.flatMap(message => (Array.isArray(message.content) ? message.content : []))
						.filter(
							part => typeof part === "object" && part !== null && "type" in part && part.type === "image_url",
						),
				).toHaveLength(1);
				expect(userTexts(initial).at(-1)).toContain("unclaimed-image-draft");
				await tui("submit", "held-native-dialogue");
				await eventually(async () => held, Boolean);
				await tui("type", "queued-native-followup");
				await tui("key", "press", "Ctrl+Enter");
				release.resolve();
				await tui("expect", "text", "queued-native-followup", "--timeout", "30000");
				await eventually(
					async () => provider.requests,
					requests => requests.some(request => continuationText(request) === "queued-native-followup"),
				);
				await idle();
				expect((await state()).run?.sessions.requirements?.sessionId).toBe(
					requirements.sessions.requirements?.sessionId,
				);
				const queued = provider.requests.findLast(
					request => continuationText(request) === "queued-native-followup",
				)!;
				expect(stageContexts(queued)).toHaveLength(1);
				expect(userTexts(queued)).toContain("held-native-dialogue");
				expect(provider.requests.some(teamStage)).toBe(false);
				await tui("resize", "120", "36");
				expect(await tui("text")).toContain("Dev ·");
			},
		);
	},
	180_000,
);

test.skipIf(!tuiTest)(
	"six public Dev entries reject ordinary-mode use, retired commands and malformed decisions without model work",
	async () => {
		await withTui({}, [100, 28], async ({ provider, tui, state, idle }) => {
			const calls = provider.requests.length;
			for (const command of ["config", `new ${REQUIREMENT}`, "next", "back", "drop"]) {
				await tui("submit", `/dev ${command}`);
				await tui("expect", "text", "请先输入 /dev", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect(await state()).toEqual({ team: false });
				await clearNativeDraft(tui, `/dev ${command}`);
				expect(await tui("text")).not.toContain("Dev ·");
			}
			await tui("submit", "/dev");
			await idle();
			for (const command of [
				"help",
				"start",
				"status",
				"answer",
				"confirm-spec",
				"choose",
				"confirm-plan",
				"revise-plan",
				"accept",
				"repair",
				"amend",
				"change-solution",
				"cancel-message",
				"pause",
				"resume",
				"cancel",
				"unknown-review-command",
			]) {
				await tui("submit", `/dev ${command}`);
				await tui("expect", "text", `未知 /dev 子命令：${command}`, "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect((await state()).run).toBeUndefined();
				await clearNativeDraft(tui, `/dev ${command}`);
			}
			for (const command of ["new", "config surplus", "back surplus", "drop surplus", "next pure normalizer"]) {
				await tui("submit", `/dev ${command}`);
				await tui("expect", "text", "用法：/dev", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect((await state()).run).toBeUndefined();
				await clearNativeDraft(tui, `/dev ${command}`);
			}
			for (const command of ["/dev next", "/dev back", "/goal set forbidden-hidden-root-goal"]) {
				await tui("submit", command);
				await tui("expect", "text", "请先|没有|不能执行|不允许|尚无", "--regex", "--timeout", "30000");
				await tui("wait", "idle", "--timeout", "30000");
				expect(await tui("text")).toContain(command);
				expect(provider.requests).toHaveLength(calls);
				expect((await state()).run).toBeUndefined();
				await clearNativeDraft(tui, command);
			}
		});
	},
	300_000,
);

for (const stop of ["Escape", "/dev", "/dev drop"] as const) {
	test.skipIf(!tuiTest)(
		`native busy next/back are rejected and ${stop} isolates late provider results and queued input`,
		async () => {
			const release = Promise.withResolvers<void>();
			let held = false;
			let returned = false;
			await withTui(
				{
					async delay(request) {
						if (continuationText(request) !== "late-old-stage-beacon" || held) return;
						held = true;
						// Deliberately ignore transport abort to exercise a real late HTTP
						// response after native cancellation, not a forged session event.
						await release.promise;
						returned = true;
					},
				},
				[100, 28],
				async ({ provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", `/dev new ${REQUIREMENT}`);
					const old = (await stage("requirements")).run!;
					await tui("submit", "late-old-stage-beacon");
					await eventually(async () => held, Boolean);
					if (stop === "Escape") {
						await tui("expect", "text", "停止当前操作，保留流程", "--timeout", "30000");
						expect(await tui("text")).not.toContain("/dev drop ·");
					}
					const calls = provider.requests.length;
					for (const command of ["/dev next", "/dev back"]) {
						await tui("submit", command);
						await tui("expect", "text", "尚未结清", "--timeout", "30000");
						expect((await state()).run?.phase).toBe("requirements");
						expect(provider.requests).toHaveLength(calls);
						await clearNativeDraft(tui, command);
					}
					const queuedText = "cancelled-old-stage-queued-input";
					await tui("type", queuedText);
					await tui("key", "press", "Ctrl+Enter");
					// The follow-up must actually leave the composer and enter the
					// native pending band before Stop, not race its async admission.
					await eventually(
						() => nativeDraftSnapshot(tui),
						({ screen, cursor }) => nativeDraftMatches(screen, "", cursor) && screen.includes(queuedText),
					);
					expect(provider.requests).toHaveLength(calls);
					if (stop === "Escape") await tui("key", "press", "Escape");
					else await tui("submit", stop);
					release.resolve();
					await eventually(async () => returned, Boolean);
					if (stop === "Escape") {
						// Ordinary Escape returns queued user input to the editor.
						// Prove its exact restoration before clearing it for /dev drop.
						await clearNativeDraft(tui, queuedText);
					}
					if (stop === "/dev") {
						await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
						await eventually(
							() => nativeDraftSnapshot(tui),
							({ screen, cursor }) => nativeDraftMatches(screen, "", cursor),
						);
						await tui("submit", "/dev");
						await stage("requirements");
					} else await idle();
					if (stop !== "/dev drop") {
						await tui("submit", "/dev drop");
						await idle();
					}
					await eventually(state, value => !value.run && !value.team);
					expect((await state()).team).toBe(false);
					expect((await state()).run).toBeUndefined();
					await eventually(
						() => nativeDraftSnapshot(tui),
						({ screen, cursor }) => nativeDraftMatches(screen, "", cursor),
					);
					await tui("submit", `/dev new ${REQUIREMENT}`);
					const current = (await stage("requirements")).run!;
					expect(current.runId).not.toBe(old.runId);
					expect(current.changeId).not.toBe(old.changeId);
					const transcript = await nativeTranscript(current, "requirements");
					expect(transcript).not.toContain("late-old-stage-beacon");
					expect(transcript).not.toContain("cancelled-old-stage-queued-input");
					expect(
						provider.requests.some(request => continuationText(request) === "cancelled-old-stage-queued-input"),
					).toBe(false);
				},
			);
		},
		180_000,
	);
}

test.skipIf(!tuiTest)(
	"native Team ordinary Escape cancels owned work and only manual back next restarts discussion",
	async () => {
		const cleanup = Promise.withResolvers<void>();
		const held = new Set<ModelRequest>();
		const aborted = new Set<ModelRequest>();
		const returned = new Set<ModelRequest>();
		const lateMarker = "cancelled-team-proposal-must-not-survive";
		let hold = true;
		try {
			await withTui(
				{
					async delay(request, signal) {
						if (!hold || !teamStage(request)) return;
						held.add(request);
						// No timer releases this request. Only a real client disconnect
						// (or final cleanup after an assertion fails) opens the barrier.
						await new Promise<void>(resolve => {
							const onAbort = () => {
								aborted.add(request);
								resolve();
							};
							if (signal.aborted) onAbort();
							else signal.addEventListener("abort", onAbort, { once: true });
							void cleanup.promise.then(() => {
								signal.removeEventListener("abort", onAbort);
								resolve();
							});
						});
					},
					reply(request) {
						const reply = respond(request);
						if (held.has(request)) {
							returned.add(request);
							// Attempt a genuine late HTTP result after transport abort;
							// the replacement discussion must never consume this proposal.
							const data = reply.tool?.args.data;
							if (isRecord(data) && typeof data.proposal === "string") data.proposal += `\n${lateMarker}`;
						}
						return reply;
					},
				},
				[120, 36],
				async ({ cwd, provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", "/dev config");
					await tui("expect", "text", "方案 Team", "--timeout", "30000");
					await tui("key", "press", "Up", "Enter");
					await eventually(state, value => value.team);
					await tui("submit", `/dev new ${REQUIREMENT}`);
					await stage("requirements");
					await tui("submit", "/dev next");
					const running = await eventually(state, value => value.run?.phase === "solution");
					await eventually(
						async () => held.size,
						count => count > 0,
					);
					expect(running.run?.sessions.solution?.sessionFile).toBeTruthy();
					const requirementsTranscript = await nativeTranscript(running.run!, "requirements");
					expect(await tui("text")).toContain("运行中");
					// Do not wait for solution idle: the native owner is still working.
					await tui("key", "press", "Escape");
					await eventually(
						async () => ({ held: held.size, aborted: aborted.size }),
						value => value.held > 0 && value.aborted === value.held,
					);
					await eventually(
						async () => returned.size,
						count => count === held.size,
					);
					await idle();
					expect(await state()).toEqual(running);
					const teamCalls = provider.requests.filter(request => teamStage(request));
					expect(new Set(teamCalls.map(teamStage))).toEqual(new Set(["proposal"]));
					expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
						false,
					);
					const solutionPath = running.run!.paths!.solution;
					expect(await Bun.file(path.join(cwd, solutionPath)).exists()).toBe(false);
					const stoppedCalls = provider.requests.length;
					// Cancellation restores the failed control command in the editor.
					// Prove that draft is present before clearing it for navigation.
					await clearNativeDraft(tui, "/dev next");
					await tui("submit", "/dev");
					await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
					await tui("submit", "/dev");
					const reentered = await stage("solution");
					// Reentry recreates runtime actors. An empty solution session may
					// also be recreated because Team was stopped before its first prompt.
					expect(reentered.team).toBe(running.team);
					expect(reentered.run?.runId).toBe(running.run?.runId);
					expect(reentered.run?.phase).toBe(running.run?.phase);
					expect(reentered.run?.changeId).toBe(running.run?.changeId);
					expect(reentered.run?.approvals).toEqual(running.run?.approvals);
					expect(reentered.run?.paths).toEqual(running.run?.paths);
					expect(reentered.run?.sessions.requirements?.sessionId).toBe(
						running.run?.sessions.requirements?.sessionId,
					);
					expect(reentered.run?.sessions.requirements?.sessionFile).toBe(
						running.run?.sessions.requirements?.sessionFile,
					);
					expect(nativeMessageEntries(await nativeTranscript(reentered.run!, "requirements"))).toEqual(
						nativeMessageEntries(requirementsTranscript),
					);
					expect(provider.requests).toHaveLength(stoppedCalls);
					await tui("submit", "/dev back");
					await stage("requirements");
					expect(provider.requests).toHaveLength(stoppedCalls);
					hold = false;
					await tui("submit", "/dev next");
					const restarted = await stage("solution");
					expect(restarted.run?.runId).toBe(running.run?.runId);
					expect(restarted.team).toBe(true);
					expect(provider.requests.filter(request => teamStage(request)).length).toBeGreaterThan(teamCalls.length);
					expect(new Set(provider.requests.filter(request => teamStage(request)).map(teamStage))).toEqual(
						new Set(["proposal", "alignment", "review", "synthesis"]),
					);
					expect(await Bun.file(path.join(cwd, solutionPath)).text()).not.toContain(lateMarker);
					expect(await nativeTranscript(restarted.run!, "solution")).not.toContain(lateMarker);
				},
			);
		} finally {
			cleanup.resolve();
		}
	},
	300_000,
);

for (const outcome of ["failure", "cancel"] as const) {
	test.skipIf(!tuiTest)(
		`native Team ${outcome} has no single-agent fallback or automatic discussion replay`,
		async () => {
			let held = false;
			let fail = outcome === "failure";
			await withTui(
				{
					fail: request => (fail && teamStage(request) ? "fixture-team-unavailable" : undefined),
					async delay(request, signal) {
						if (outcome !== "cancel" || !teamStage(request) || held) return;
						held = true;
						await new Promise<void>((_, reject) => {
							if (signal.aborted) reject(signal.reason);
							else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
						});
					},
				},
				[120, 36],
				async ({ provider, tui, state, stage, idle }) => {
					await tui("submit", "/dev");
					await idle();
					await tui("submit", "/dev config");
					await tui("expect", "text", "方案 Team", "--timeout", "30000");
					await tui("key", "press", "Up", "Enter");
					await eventually(state, value => value.team);
					await tui("submit", `/dev new ${REQUIREMENT}`);
					await stage("requirements");
					await tui("submit", "/dev next");
					await eventually(state, value => value.run?.phase === "solution");
					if (outcome === "cancel") {
						await eventually(async () => held, Boolean);
						await tui("submit", "/dev drop");
						await eventually(state, value => !value.run && !value.team);
						await idle();
						expect((await state()).team).toBe(false);
						expect((await state()).run).toBeUndefined();
						expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
							false,
						);
						return;
					}
					// The fixed error row reports terminal Team failure; its full
					// per-member provider cause can require the scrollable details.
					await expectNativeFailure(tui, /Team failed:/, "fixture-team-unavailable", "/dev next");
					await idle();
					expect((await state()).run?.phase).toBe("solution");
					expect((await state()).team).toBe(true);
					expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
						false,
					);
					const failedCalls = provider.requests.filter(request => teamStage(request)).length;
					await tui("submit", "只解释当前 Team 失败，不重跑讨论，不批准。");
					// Team failed before the native stage handoff; its first ordinary
					// reply therefore has no rolePayload/continuationText marker.
					await tui("expect", "text", `${MARKER}_CHAT_READY`, "--timeout", "30000");
					await idle();
					expect(provider.requests.filter(request => teamStage(request))).toHaveLength(failedCalls);
					expect((await state()).run?.phase).toBe("solution");
					await tui("submit", "/dev");
					await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
					await tui("submit", "/dev");
					await stage("solution");
					expect(provider.requests.filter(request => teamStage(request))).toHaveLength(failedCalls);
					await tui("submit", "/dev back");
					await stage("requirements");
					fail = false;
					await tui("submit", "/dev next");
					await stage("solution");
					expect(provider.requests.filter(request => teamStage(request)).length).toBeGreaterThan(failedCalls);
					expect(provider.requests.some(request => rolePayload(request)?.specDrivenRole === "solution")).toBe(
						true,
					);
				},
			);
		},
		300_000,
	);
}

test.skipIf(!tuiTest)(
	"ordinary native work and Plan mode block Dev entry without stopping unrelated work or clearing root history",
	async () => {
		let held = false;
		let aborted = false;
		let delaySettled = false;
		await withTui(
			{
				async delay(request, signal) {
					if (rolePayload(request) || !userTexts(request).at(-1)?.endsWith("held-ordinary-work")) return;
					held = true;
					try {
						await new Promise<void>((_, reject) => {
							const abort = () => {
								aborted = true;
								reject(signal.reason);
							};
							if (signal.aborted) abort();
							else signal.addEventListener("abort", abort, { once: true });
						});
					} finally {
						delaySettled = true;
					}
				},
			},
			[100, 28],
			async ({ provider, tui, state, idle }) => {
				await tui("submit", "held-ordinary-work");
				await eventually(async () => held, Boolean);
				const calls = provider.requests.length;
				const original = await state();
				await tui("submit", "/dev");
				await tui("expect", "text", "普通会话仍有原生输入或任务", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect(await state()).toEqual(original);
				await clearNativeDraft(tui, "/dev");
				expect(aborted).toBe(false);
				expect(delaySettled).toBe(false);
				await tui("key", "press", "Escape");
				await eventually(async () => aborted && delaySettled, Boolean);
				await tui("submit", "/plan");
				await tui("expect", "text", "Plan mode enabled.", "--timeout", "30000");
				await tui("submit", "/dev");
				await tui("expect", "text", "请先退出 Plan、Goal 或 Vibe 模式", "--timeout", "30000");
				expect(provider.requests).toHaveLength(calls);
				expect(await state()).toEqual(original);
				expect(await tui("text", "--full")).toContain("ordinary-root-beacon");
				await clearNativeDraft(tui, "/dev");
				await tui("submit", "/plan");
				await tui("expect", "text", "Plan mode paused.", "--timeout", "30000");
				await tui("submit", "/plan");
				await tui("expect", "text", "Plan mode disabled", "--timeout", "30000");
				await tui("submit", "/dev");
				await idle();
				expect(provider.requests).toHaveLength(calls);
			},
		);
	},
	180_000,
);
