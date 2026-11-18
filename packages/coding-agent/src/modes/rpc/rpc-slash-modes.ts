import { cfgGoalEnabled } from "../../goals/settings";
import { readPlanFile } from "../../plan-mode/plan-files";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import {
	planVerificationChecks,
	recordApprovedPlanReference,
	verificationApprovalDetails,
} from "../../plan-mode/verification";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { commandConsumed } from "../../slash-commands/helpers/parse";
import type { RpcSlashCommandRuntime, SlashCommandResult, SlashCommandRuntime } from "../../slash-commands/types";
import { evaluateLoopCondition } from "../loop-condition";
import { isLoopGoalComplete, renderLoopGoalPrompt } from "../loop-goal";
import { consumeLoopLimitIteration, createLoopLimitRuntime, isLoopLimitExhausted, parseLoopArgs } from "../loop-limit";
import { cfgLoopConditionTimeoutMs, cfgLoopMode } from "../settings";
import type { RpcGoalController } from "./rpc-goal";

/** Slash-mode state owned by the real RPC session rather than a synthetic interactive host. */
export function createRpcSlashModes(
	session: AgentSession,
	goals: RpcGoalController,
	ui: RpcSlashCommandRuntime["ui"],
	output: SlashCommandRuntime["output"],
) {
	let loop:
		| {
				args: Exclude<ReturnType<typeof parseLoopArgs>, string>;
				limit: ReturnType<typeof createLoopLimitRuntime>;
				goal: boolean;
				generation: number;
				owner: string;
				prompt?: string;
				timer?: ReturnType<typeof setTimeout>;
				iteration?: AbortController;
		  }
		| undefined;
	let planSessionId: string | undefined;
	let planApproval: AbortController | undefined;
	let disposed = false;

	function stopLoop(disable: boolean): void {
		if (!loop) return;
		clearTimeout(loop.timer);
		loop.timer = undefined;
		loop.iteration?.abort();
		loop.iteration = undefined;
		loop.prompt = undefined;
		if (disable) loop = undefined;
	}

	function interrupt(): void {
		stopLoop(false);
		planApproval?.abort();
	}

	function sessionChanged(): void {
		if (loop?.generation !== session.sessionGeneration) stopLoop(true);
		if (planSessionId !== undefined && planSessionId !== session.sessionManager.getSessionId()) {
			planApproval?.abort();
			planSessionId = undefined;
			session.setPlanProposalHandler(null);
			session.setPlanModeState(undefined);
		}
	}

	function beforeSessionChange(): void {
		planApproval?.abort();
	}

	function scheduleLoop(): void {
		const current = loop;
		const text = current?.prompt;
		if (disposed || !current || !text || current.timer || current.iteration) return;
		current.timer = setTimeout(() => {
			current.timer = undefined;
			const iteration = new AbortController();
			current.iteration = iteration;
			const isCurrent = () =>
				!disposed &&
				loop === current &&
				!iteration.signal.aborted &&
				!session.isDisposed &&
				current.generation === session.sessionGeneration &&
				current.owner === session.sessionManager.getSessionId() &&
				!session.isSessionTransitioning;
			const busy = () =>
				session.isStreaming ||
				session.isCompacting ||
				session.hasPostPromptWork ||
				session.hasAdmittedSubmission ||
				session.queuedMessageCount > 0;
			let defer = false;
			void (async () => {
				await session.waitForIdle();
				if (!isCurrent()) return;
				if (busy()) {
					defer = true;
					return;
				}
				if (isLoopLimitExhausted(current.limit)) {
					stopLoop(true);
					await output("Loop limit reached. Loop mode disabled.");
					return;
				}
				if (current.args.condition) {
					const verdict = await evaluateLoopCondition(current.args.condition, {
						cwd: session.sessionManager.getCwd(),
						timeoutMs: cfgLoopConditionTimeoutMs.get(session.settings),
						sessionId: current.owner,
						signal: iteration.signal,
						isSessionCurrent: isCurrent,
					});
					if (!isCurrent()) return;
					if (verdict.kind !== "continue") {
						stopLoop(true);
						if ("message" in verdict)
							await output(verdict.message, verdict.kind === "error" ? "error" : undefined);
						return;
					}
				}
				if (busy()) {
					defer = true;
					return;
				}
				if (!consumeLoopLimitIteration(current.limit)) {
					stopLoop(true);
					await output("Loop limit reached. Loop mode disabled.");
					return;
				}
				const action = cfgLoopMode.get(session.settings);
				if (action === "compact") await session.compact(undefined, { suppressContinuation: true });
				else if (action === "reset") {
					if (session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode before using reset loops.");
					if (!(await session.resetSessionContext())) throw new Error("Loop context reset was refused.");
					current.generation = session.sessionGeneration;
				}
				if (!isCurrent()) return;
				current.iteration = undefined;
				await session.prompt(text);
			})()
				.catch(error => {
					if (!isCurrent()) return;
					stopLoop(true);
					void output(`Loop mode disabled: ${error instanceof Error ? error.message : String(error)}`, "error");
				})
				.finally(() => {
					if (current.iteration === iteration) current.iteration = undefined;
					if (defer && isCurrent()) scheduleLoop();
				});
		}, current.args.intervalMs ?? 1000);
	}

	function observe(event: AgentSessionEvent): void {
		const current = loop;
		if (!current) return;
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			if (current.generation !== session.sessionGeneration) return;
			stopLoop(false);
			current.prompt =
				typeof event.message.content === "string"
					? event.message.content
					: event.message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n");
		} else if (event.type === "agent_end" && current.prompt) {
			if (current.goal && isLoopGoalComplete(event.messages)) stopLoop(true);
			else if (
				event.messages.some(
					message =>
						message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error"),
				)
			) {
				stopLoop(false);
			} else scheduleLoop();
		}
	}

	async function runPlan(args: string): Promise<SlashCommandResult> {
		if (session.getPlanModeState()?.enabled) {
			planApproval?.abort();
			await session.runModeExitTeardown(async () => {
				if (session.isStreaming) await session.abort();
				session.setPlanProposalHandler(null);
				session.setPlanModeState(undefined);
				planSessionId = undefined;
			});
			await output("Plan mode disabled.");
			return commandConsumed();
		}
		if (!cfgPlanEnabled.get(session.settings)) throw new Error("Plan mode is disabled (plan.enabled).");
		if (session.getGoalModeState()?.enabled || session.getVibeModeState()?.enabled)
			throw new Error("Exit goal/vibe mode first.");
		const planFilePath = "local://PLAN.md";
		planSessionId = session.sessionManager.getSessionId();
		session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel" });
		session.setPlanProposalHandler(async title => {
			if (disposed || session.isSessionTransitioning) throw new Error("The RPC session is changing or stopping.");
			const approval = new AbortController();
			planApproval?.abort();
			planApproval = approval;
			try {
				const proposal = await session.preparePlanForReview(title);
				const { details } = proposal;
				if (!details) throw new Error("The plan proposal has no review details.");
				approval.signal.throwIfAborted();
				const content = await readPlanFile(details.planFilePath, {
					cwd: session.sessionManager.getCwd(),
					localProtocolOptions: {
						getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
						getSessionId: () => session.sessionManager.getSessionId(),
					},
				});
				const checks = content ? planVerificationChecks(content) : undefined;
				const approved = content
					? await ui.confirm(
							`Approve plan: ${details.title}`,
							content.slice(0, 4000) + verificationApprovalDetails(checks),
							{ signal: approval.signal, timeout: 120_000 },
						)
					: false;
				approval.signal.throwIfAborted();
				if (planSessionId !== session.sessionManager.getSessionId() || session.isSessionTransitioning) {
					throw new Error("The RPC session changed during plan review.");
				}
				if (!approved) {
					return { ...proposal, content: [{ type: "text", text: "Plan not approved. Keep planning." }] };
				}
				session.setPlanProposalHandler(null);
				session.setPlanModeState(undefined);
				recordApprovedPlanReference(session, details.planFilePath, checks);
				planSessionId = undefined;
				return { ...proposal, content: [{ type: "text", text: "Plan approved. Proceed with implementation." }] };
			} finally {
				if (planApproval === approval) planApproval = undefined;
			}
		});
		if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
		await output(`Plan mode enabled. Plan file: ${planFilePath}`);
		return args ? { prompt: args } : commandConsumed();
	}

	async function runGoal(args: string, autoOrchestrate: boolean, signal: AbortSignal): Promise<SlashCommandResult> {
		const generation = session.sessionGeneration;
		await goals.settled();
		if (!cfgGoalEnabled.get(session.settings)) throw new Error("Goal mode is disabled (goal.enabled).");
		let verb = /^\S+/.exec(args)?.[0] ?? "";
		const rest = args.slice(verb.length).trim();
		const current = session.getGoalModeState();
		const assertCurrent = () => {
			signal.throwIfAborted();
			if (
				disposed ||
				session.isSessionTransitioning ||
				session.sessionGeneration !== generation ||
				session.getGoalModeState()?.goal.id !== current?.goal.id
			) {
				throw new Error("The RPC session or goal changed during the command.");
			}
		};
		assertCurrent();
		if (!verb && current?.goal) {
			const choice = await ui.select(
				`Goal: ${current.goal.objective} (${current.goal.status})`,
				current.enabled ? ["show", "budget", "pause", "drop"] : ["show", "resume", "drop"],
				{ signal },
			);
			if (!choice) return commandConsumed();
			assertCurrent();
			verb = choice;
		}
		switch (verb) {
			case "show":
				await output(current?.goal ? JSON.stringify(current.goal, null, 2) : "No goal set.");
				return commandConsumed();
			case "pause":
				if (!current?.enabled) throw new Error("No active goal to pause.");
				await goals.handle({ op: "pause" });
				await output("Goal mode paused.");
				return commandConsumed();
			case "resume":
				await goals.handle({ op: "resume" });
				await output("Goal mode resumed.");
				return commandConsumed();
			case "drop":
				if (!current?.goal) throw new Error("No goal to drop.");
				if (await ui.confirm("Drop goal?", "Accumulated usage stays in the session log.", { signal })) {
					assertCurrent();
					await goals.handle({ op: "drop" });
					await output("Goal dropped.");
				}
				return commandConsumed();
			case "budget": {
				if (!current?.enabled) throw new Error("Resume the goal before adjusting the budget.");
				const budget =
					rest ||
					(await ui.input("Goal budget (positive integer or off)", current.goal.tokenBudget?.toString(), {
						signal,
					}));
				if (budget === undefined) return commandConsumed();
				assertCurrent();
				const amount = Number(budget);
				if (budget !== "off" && (!/^[1-9]\d*$/.test(budget) || !Number.isSafeInteger(amount)))
					throw new Error("Goal budget must be a positive integer or off.");
				await session.goalRuntime.onBudgetMutated(budget === "off" ? undefined : amount);
				goals.notifyHostAction();
				await output(budget === "off" ? "Goal budget cleared." : `Goal budget set to ${amount}.`);
				return commandConsumed();
			}
		}
		if (session.getVibeModeState()?.enabled) throw new Error("Exit vibe mode before starting a goal.");
		const objective =
			(verb === "set" ? rest : args) || (await ui.input("Goal objective", undefined, { signal }))?.trim();
		if (!objective) return commandConsumed();
		assertCurrent();
		const state = await goals.setSlashGoal(objective, autoOrchestrate, verb === "set");
		await output("Goal mode enabled.");
		return { prompt: objective, ...(state.autoOrchestrate ? { goalAutoOrchestrateInitialId: state.goal.id } : {}) };
	}

	async function run(
		mode: Parameters<RpcSlashCommandRuntime["runModeCommand"]>[0],
		args: string,
		signal: AbortSignal,
	): Promise<SlashCommandResult> {
		if (disposed) throw new Error("The RPC host has stopped.");
		if (mode === "plan") return runPlan(args);
		if (mode === "goal" || mode === "goal-autopilot") return runGoal(args, mode === "goal-autopilot", signal);
		if (loop) {
			stopLoop(true);
			await output("Loop mode disabled.");
			return commandConsumed();
		}
		const parsed = parseLoopArgs(args);
		if (typeof parsed === "string") throw new Error(parsed);
		loop = {
			args: parsed,
			limit: createLoopLimitRuntime(parsed.limit),
			goal: mode === "loopgoal",
			generation: session.sessionGeneration,
			owner: session.sessionManager.getSessionId(),
		};
		if (parsed.intervalMs !== undefined) consumeLoopLimitIteration(loop.limit);
		await output("Loop mode enabled. Stop suspends repeats; /loop disables it.");
		return parsed.prompt ? { prompt: parsed.prompt } : commandConsumed();
	}

	return {
		run,
		observe,
		interrupt,
		beforeSessionChange,
		sessionChanged,
		dispose: () => {
			disposed = true;
			stopLoop(true);
			planApproval?.abort();
		},
		transformPrompt: (text: string) => (loop?.goal ? renderLoopGoalPrompt(text) : text),
	};
}
