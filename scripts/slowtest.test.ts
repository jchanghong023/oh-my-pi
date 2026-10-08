import { describe, expect, test } from "bun:test";
import {
	conclusionExitCode,
	parseSlowtestArgs,
	pickTriggeredRun,
	resolveSlowtestHead,
	waitForOwnedChild,
	workflowDispatchArgv,
	type GhRunSummary,
} from "./slowtest.ts";

const TRIGGERED_AT = Date.parse("2026-09-18T10:00:00Z");
const RUN_ID = "isolated-fixture";

function run(overrides: Partial<GhRunSummary>): GhRunSummary {
	return {
		databaseId: 1,
		status: "queued",
		conclusion: null,
		headSha: "a".repeat(40),
		createdAt: new Date(TRIGGERED_AT + 5_000).toISOString(),
		url: "https://github.com/example/example/actions/runs/1",
		displayTitle: `CI (slowtest ${RUN_ID})`,
		...overrides,
	};
}

describe("pickTriggeredRun", () => {
	test("matches the run for the pushed head sha", () => {
		const match = run({ databaseId: 7 });
		expect(pickTriggeredRun([run({ headSha: "b".repeat(40) }), match], "a".repeat(40), TRIGGERED_AT, RUN_ID)).toBe(
			match,
		);
	});

	test("prefers the newest matching run", () => {
		const older = run({ databaseId: 7, createdAt: new Date(TRIGGERED_AT + 5_000).toISOString() });
		const newer = run({ databaseId: 8, createdAt: new Date(TRIGGERED_AT + 60_000).toISOString() });
		expect(pickTriggeredRun([older, newer], "a".repeat(40), TRIGGERED_AT, RUN_ID)?.databaseId).toBe(8);
	});

	test("rejects runs created before the trigger moment beyond clock-skew slack", () => {
		const stale = run({ databaseId: 9, createdAt: new Date(TRIGGERED_AT - 10 * 60_000).toISOString() });
		expect(pickTriggeredRun([stale], "a".repeat(40), TRIGGERED_AT, RUN_ID)).toBeUndefined();
	});

	test("ignores runs with unparseable creation timestamps", () => {
		const invalid = run({ createdAt: "not-a-date" });
		expect(pickTriggeredRun([invalid], "a".repeat(40), TRIGGERED_AT, RUN_ID)).toBeUndefined();
	});

	test("returns undefined when nothing matches", () => {
		expect(pickTriggeredRun([], "a".repeat(40), TRIGGERED_AT, RUN_ID)).toBeUndefined();
	});

	test("ignores another dispatch at the same HEAD even when it is newer", () => {
		const own = run({ databaseId: 7 });
		const other = run({
			databaseId: 8,
			displayTitle: "CI (slowtest another-invocation)",
			createdAt: new Date(TRIGGERED_AT + 60_000).toISOString(),
		});
		expect(pickTriggeredRun([own, other], "a".repeat(40), TRIGGERED_AT, RUN_ID)?.databaseId).toBe(7);
		expect(pickTriggeredRun([other], "a".repeat(40), TRIGGERED_AT, RUN_ID)).toBeUndefined();
	});
});

describe("workflowDispatchArgv", () => {
	test("dispatches the release flavor of the CI workflow", () => {
		expect(workflowDispatchArgv(RUN_ID)).toEqual([
			"gh",
			"workflow",
			"run",
			"ci.yml",
			"--ref",
			"main",
			"-f",
			"publish_release=true",
			"-f",
			`slowtest_run_id=${RUN_ID}`,
		]);
	});
});

describe("conclusionExitCode", () => {
	test("success is the only green conclusion", () => {
		expect(conclusionExitCode("success")).toBe(0);
		expect(conclusionExitCode("failure")).toBe(1);
		expect(conclusionExitCode("cancelled")).toBe(1);
		expect(conclusionExitCode(null)).toBe(1);
	});
});

describe("parseSlowtestArgs", () => {
	test("no arguments defaults to a non-debug run", () => {
		expect(parseSlowtestArgs([])).toEqual({ debug: false });
	});

	test("--debug forwards to fulltest", () => {
		expect(parseSlowtestArgs(["--debug"])).toEqual({ debug: true });
	});

	test("unknown arguments are rejected", () => {
		expect(parseSlowtestArgs(["--release"])).toBeNull();
		expect(parseSlowtestArgs(["--debug", "extra"])).toBeNull();
	});
});

describe("resolveSlowtestHead", () => {
	function capture(state: { branch?: string; dirty?: boolean; sha?: string; failed?: string }) {
		return (argv: readonly string[]) => ({
			exitCode: argv[1] === state.failed ? 1 : 0,
			stdout:
				argv[1] === "status"
					? state.dirty
						? " M scripts/slowtest.ts\n"
						: ""
					: argv.includes("--abbrev-ref")
						? (state.branch ?? "main")
						: (state.sha ?? "a".repeat(40)),
		});
	}

	test("rejects an uncommitted tree before it can become the published commit", () => {
		expect(() => resolveSlowtestHead(undefined, capture({ dirty: true }))).toThrow("must be clean");
	});

	test("rejects a commit or branch changed after local or WSL validation", () => {
		const testedSha = resolveSlowtestHead(undefined, capture({}));
		expect(() => resolveSlowtestHead(testedSha, capture({ sha: "b".repeat(40) }))).toThrow("HEAD changed");
		expect(() => resolveSlowtestHead(testedSha, capture({ branch: "feature" }))).toThrow("branch to be main");
	});

	test("fails closed when Git cannot inspect the tree or HEAD", () => {
		expect(() => resolveSlowtestHead(undefined, capture({ failed: "status" }))).toThrow("must be clean");
		expect(() => resolveSlowtestHead(undefined, capture({ failed: "rev-parse" }))).toThrow("branch to be main");
	});
});

describe("owned subprocess cancellation", () => {
	test("aborting the stage kills its child without accepting success or touching another child", async () => {
		const detached = process.platform !== "win32";
		const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
			detached,
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});
		const unrelated = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "ignore",
		});
		const controller = new AbortController();
		try {
			const waiting = waitForOwnedChild(child, controller.signal, detached);
			controller.abort(new Error("canceled"));
			await expect(waiting).rejects.toThrow("canceled");
			expect(child.exitCode).not.toBeNull();
			expect(unrelated.exitCode).toBeNull();
		} finally {
			child.kill();
			unrelated.kill();
			await Promise.all([child.exited, unrelated.exited]);
		}
	}, 10_000);
});
