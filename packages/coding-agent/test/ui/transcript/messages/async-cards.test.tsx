/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterAll, expect, setSystemTime, test } from "bun:test";
import { createRoot, signal } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import "../../../../src/ui/styles/tools/irc";
import type { AsyncNotifyDetails } from "../../../../src/session/transcript/messages";
import { extensionOutput } from "../../../../src/ui/extensions/render-output";
import {
	AsyncNotify,
	AsyncResult,
	IrcMessageBlock,
	LaunchCompletion,
	type LaunchCompletionDetails,
	ParentIrcMessage,
} from "../../../../src/ui/transcript/messages/async-cards";
import type { FramedMessage, FrameRenderer } from "../../../../src/ui/transcript/messages/frame";
import { region, screenSuite, single } from "./harness";

afterAll(() => setSystemTime());

/** The transcript's expansion and tool-activity toggles, driven by the stage labels. */
function toggles() {
	const expanded = signal(false);
	const visible = signal(true);
	return {
		expanded,
		visible,
		apply(label: string): void {
			if (label === "expanded") expanded.set(true);
			else if (label === "collapsed") expanded.set(false);
			else if (label === "tool activity hidden") visible.set(false);
			else if (label === "tool activity shown") visible.set(true);
			else throw new Error(`unknown stage ${label}`);
		},
	};
}

/** The capture's `async-result` renderers, by how the inputs describe them. */
function renderer(doc: string | null): FrameRenderer | undefined {
	if (doc === null) return undefined;
	if (doc.startsWith("returns undefined")) return () => undefined;
	if (doc.startsWith("throws")) {
		return () => {
			throw new Error("boom");
		};
	}
	if (doc.startsWith("always")) {
		const same = <text spans={[{ t: "custom same" }]} wrap="word" />;
		return () => same;
	}
	if (doc.startsWith("returns a rows object")) {
		return expanded =>
			extensionOutput({
				render: () => [`rows ${expanded ? "expanded" : "collapsed"}`],
			});
	}
	const flip = doc.startsWith("undefined while collapsed");
	return expanded =>
		flip && !expanded ? undefined : (
			<text spans={[{ t: `custom ${expanded ? "expanded" : "collapsed"}`, s: "accent" }]} wrap="word" />
		);
}

screenSuite("async-result", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: FramedMessage & { details?: unknown };
		renderer: string | null;
	};
	const t = toggles();
	return {
		node: region(
			<AsyncResult
				message={inputs.message}
				expanded={t.expanded}
				visible={t.visible}
				renderer={renderer(inputs.renderer)}
				onToggle={open => t.expanded.set(open)}
			/>,
		),
		apply: t.apply,
	};
});

screenSuite("async-notify", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: { details?: AsyncNotifyDetails };
	};
	const t = toggles();
	return {
		node: single(<AsyncNotify details={inputs.message.details} visible={t.visible} />),
		apply: t.apply,
	};
});

screenSuite("launch-completion", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: { details?: LaunchCompletionDetails; content: unknown };
	};
	const t = toggles();
	return {
		node: single(
			<LaunchCompletion details={inputs.message.details} content={inputs.message.content} visible={t.visible} />,
		),
		apply: t.apply,
	};
});

screenSuite("irc-message", corpusCase => {
	const inputs = corpusCase.inputs as {
		message: { customType: string; details?: unknown; timestamp: number };
		nowMs: number;
	};
	setSystemTime(new Date(inputs.nowMs));
	const t = toggles();
	return {
		node: single(<IrcMessageBlock message={inputs.message} expanded={t.expanded} visible={t.visible} />),
		apply: t.apply,
	};
});

screenSuite("parent-irc", corpusCase => {
	const inputs = corpusCase.inputs as {
		parentIrc: { from: string; body: string };
		timestamp: number;
		nowMs: number;
	};
	setSystemTime(new Date(inputs.nowMs));
	const t = toggles();
	return {
		node: single(
			<ParentIrcMessage parentIrc={inputs.parentIrc} timestamp={inputs.timestamp} expanded={t.expanded} />,
		),
		apply: t.apply,
	};
});

test("displays process receipts and task diagnostics without automatic task status rows", () => {
	const message = {
		customType: "async-result",
		content: "results",
		details: {
			jobs: [
				{ jobId: "bash-complete", type: "bash", status: "completed", durationMs: 1000 },
				{ jobId: "bash-failed", type: "bash", status: "failed", label: "compile project" },
				{ jobId: "bash-cancelled", type: "bash", status: "cancelled" },
				{ jobId: "eval-cancelled", type: "eval", status: "cancelled" },
				{ jobId: "eval-running", type: "eval", status: "running" },
				{
					jobId: "task-failed",
					type: "task",
					status: "failed",
					meta: { artifactError: "write" },
					schema: { status: "invalid", error: "invalid output" },
				},
				{ jobId: "task-complete", type: "task", status: "completed" },
				{ jobId: "task-cancelled", type: "task", status: "cancelled" },
			],
		},
	};
	const original = structuredClone(message);
	createRoot(dispose => {
		try {
			const visible = signal(true);
			const node = region(<AsyncResult message={message} expanded={false} visible={visible} />)();
			const env = staticEnvironment(PLAIN_THEME);
			for (const output of [
				Bun.stripANSI(paintNode(env, node, 160).rows.join("\n")),
				JSON.stringify(describeTree(node, env)),
			]) {
				for (const marker of [
					"Background job completed",
					"bash-complete",
					"Background job failed",
					"bash-failed",
					"compile project",
					"Background job cancelled",
					"bash-cancelled",
					"eval-cancelled",
					"artifact write failed",
					"task-failed: Structured output invalid: invalid output",
				])
					expect(output).toContain(marker);
				expect(output.match(/task-failed/g)).toHaveLength(1);
				for (const marker of ["eval-running", "task-complete", "task-cancelled"])
					expect(output).not.toContain(marker);
			}
			visible.set(false);
			expect(paintNode(env, node, 160).rows).toEqual([]);
			expect(describeTree(node, env)).toMatchObject({ p: { role: "omp.activity", hidden: true } });
			const legacy = region(
				<AsyncResult
					message={{
						customType: "async-result",
						content: "single",
						details: { jobId: "single-task", type: "task", status: "failed" },
					}}
					expanded={false}
					visible={true}
				/>,
			)();
			expect(paintNode(env, legacy, 160).rows).toEqual([]);
			expect(JSON.stringify(describeTree(legacy, env))).not.toContain("single-task");
		} finally {
			dispose();
		}
	});
	expect(message).toEqual(original);
});

test("process exit details survive replay and the tool activity visibility toggle without changing the message", () => {
	const broker = { id: "broker-service", createdAt: 0, persist: false, detached: false };
	const details: LaunchCompletionDetails = {
		daemons: [
			{ ...broker, name: "healthy", state: "exited", exitCode: 0, startedAt: 1000, exitedAt: 2000 },
			{ ...broker, name: "failed-state", state: "failed", exitCode: 0, startedAt: 1000, exitedAt: 3100 },
			{ ...broker, name: "nonzero", state: "exited", exitCode: 7, startedAt: 1000, exitedAt: 4200 },
			{ ...broker, name: "unknown-exit", state: "exited", startedAt: 1000, exitedAt: 4300 },
			{ ...broker, name: "failed-unknown", state: "failed", startedAt: 1000, exitedAt: 4400 },
		],
	};
	const original = JSON.stringify(details);
	for (const current of [details, JSON.parse(original) as LaunchCompletionDetails]) {
		createRoot(dispose => {
			try {
				const visible = signal(true);
				const node = single(<LaunchCompletion details={current} content="processes exited" visible={visible} />);
				const env = staticEnvironment(PLAIN_THEME);
				const rows = () => Bun.stripANSI(paintNode(env, node, 200).rows.join("\n"));
				const native = () => JSON.stringify(describeTree(node, env));
				for (const output of [rows(), native()])
					for (const marker of ["healthy", "failed-state", "nonzero", "exit 7", "unknown-exit", "failed-unknown"])
						expect(output).toContain(marker);
				expect(rows()).toContain("Supervised process completed healthy");
				visible.set(false);
				expect(rows()).toBe("");
				expect(describeTree(node, env)).toMatchObject({ p: { role: "omp.activity", hidden: true } });
				visible.set(true);
				expect(rows()).toContain("exit 7");
			} finally {
				dispose();
			}
		});
		expect(JSON.stringify(current)).toBe(original);
	}
});
