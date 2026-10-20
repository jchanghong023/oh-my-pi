#!/usr/bin/env bun
// Public task selection only: Bazel owns scheduling and result reuse.
import * as path from "node:path";
import type { BazelPrimitiveTask } from "./bazel-primitive";
import { parseBazelPrimitive, runBazelPrimitive } from "./bazel-primitive";
import { runWorkspaceBuild } from "./bazel-workspace-build";
import { runBazelCommands } from "./test-gate-bazel";
import { GateCommandError } from "./test-gate-failure-events";
import { runBazelTask } from "./test-gate-runtime";
import type { GateCommand } from "./test-gate-runtime";

const root = path.resolve(import.meta.dir, "..");
const tasks = {
	check: { kind: "static", external: true },
	"check:ts": { kind: "static", external: false },
	"check:tools": { kind: "static", external: false },
	"check:rs": { kind: "static", external: true },
	lint: { kind: "static", external: true },
	"lint:ts": { kind: "static", external: false },
	"lint:tools": { kind: "static", external: false },
	"lint:rs": { kind: "static", external: true },
	"lint:py": { kind: "static", external: true },
	build: { kind: "build", external: true },
	"build:native": { kind: "build", external: true },
	"collab:web:build": { kind: "build", external: true },
	"robomp:web:build": { kind: "build", external: true },
	test: { kind: "test", external: true },
	"test:ts": { kind: "test", external: false },
	"ci:test:ts": { kind: "test", external: false },
	"ci:test:ts:workspace": { kind: "test", external: false },
	"ci:test:ts:native": { kind: "test", external: false },
	"ci:test:coding-agent:singleton": { kind: "test", external: false },
	"ci:test:coding-agent:ui": { kind: "test", external: false },
	"ci:test:coding-agent:runtime": { kind: "test", external: false },
	"ci:test:coding-agent:native": { kind: "test", external: false },
	"ci:test:coding-agent:heavy": { kind: "test", external: false },
	"test:scripts": { kind: "test", external: false },
	"test:rs": { kind: "test", external: true },
	"test:py": { kind: "test", external: true },
	"robomp:test:integration": { kind: "test", external: true },
	"sdk:test:go": { kind: "test", external: true },
	"sdk:test:go:smoke": { kind: "test", external: true },
	"sdk:test:rust": { kind: "test", external: true },
	"ci:test:smoke": { kind: "test", external: true },
	"ci:test:install-methods": { kind: "test", external: true },
} as const satisfies Record<BazelPrimitiveTask, { kind: string; external: boolean }>;

/** A single original public primitive retains its own order, reporter and selector. */
export function publicBazelCommand(args: readonly string[]): GateCommand {
	const { task, flags } = parseBazelPrimitive(args);
	const definition = tasks[task];
	return {
		label: `${definition.kind}/public/${task}${flags.length ? ` ${flags.join(" ")}` : ""}`,
		argv: ["bun", path.join(root, "scripts/bazel-primitive.ts"), task, ...flags],
		cwd: root,
		...(definition.external ? { resultReuse: "disabled" as const } : {}),
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (process.env.OMP_GATE_BAZEL_PRIMITIVE === "1") {
		// The enclosing Bazel payload already owns this lane and its inputs.
		try {
			process.exitCode = await runBazelPrimitive(args);
		} catch (error) {
			if (!(error instanceof GateCommandError)) throw error;
			console.error(error.message);
			process.exitCode = error.exitCode;
		}
	} else {
		const result = await runBazelTask(
			async gate => {
				const { task } = parseBazelPrimitive(args);
				console.log(`scope=standalone-public-task selection=${JSON.stringify(args)}`);
				if (task === "build" || task === "collab:web:build" || task === "robomp:web:build") {
					await runWorkspaceBuild(gate, task);
				} else {
					await runBazelCommands(gate, [publicBazelCommand(args)]);
				}
			},
			{ reportFailure: true, exitOnFailure: true },
		);
		process.exitCode = result.exitCode;
	}
}
