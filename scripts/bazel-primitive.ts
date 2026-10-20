#!/usr/bin/env bun
import { $ } from "bun";
import * as path from "node:path";
import { ompBazelPrimitives } from "../package.json";
import { GateCommandError } from "./test-gate-failure-events";

export type BazelPrimitiveTask = keyof typeof ompBazelPrimitives;

/** Resolve only the root registry; flags never become unquoted shell source. */
export function parseBazelPrimitive(args: readonly string[]): { task: BazelPrimitiveTask; flags: string[] } {
	const [task, ...flags] = args[0] === "--" ? args.slice(1) : args;
	if (!task || !Object.hasOwn(ompBazelPrimitives, task)) {
		throw new GateCommandError(
			`Usage: bun run bazel -- <task> [task arguments]\nTasks: ${Object.keys(ompBazelPrimitives).join(", ")}`,
			2,
		);
	}
	const allowed = task === "test:rs" ? ["--affected", "--dry-run"] : task === "sdk:test:go" ? ["--smoke"] : [];
	if (new Set(flags).size !== flags.length || flags.some(flag => !allowed.includes(flag))) {
		throw new GateCommandError(`Invalid arguments for ${task}: ${flags.join(" ")}`, 2);
	}
	return { task: task as BazelPrimitiveTask, flags };
}

/** Bun's native shell retains operators, quoting, streaming output and exit status. */
export async function runBazelPrimitive(args: readonly string[]): Promise<number> {
	const { task, flags } = parseBazelPrimitive(args);
	const command = ompBazelPrimitives[task];
	const result = await $`${{ raw: command }} ${flags}`
		.cwd(process.cwd())
		.env({
			...process.env,
			PATH: `${path.resolve(import.meta.dir, "../node_modules/.bin")}${path.delimiter}${process.env.PATH ?? ""}`,
			OMP_GATE_BAZEL_PRIMITIVE: "1",
		})
		.nothrow();
	return result.exitCode;
}

if (import.meta.main) {
	try {
		process.exitCode = await runBazelPrimitive(process.argv.slice(2));
	} catch (error) {
		if (!(error instanceof GateCommandError)) throw error;
		console.error(error.message);
		process.exitCode = error.exitCode;
	}
}
