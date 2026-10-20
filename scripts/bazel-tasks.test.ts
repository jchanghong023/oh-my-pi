import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { parseBazelPrimitive } from "./bazel-primitive";
import { publicBazelCommand } from "./bazel-tasks";

describe("public Bazel primitive routing", () => {
	test("rejects gate recursion, unknown tasks, duplicate and unsupported flags", () => {
		for (const args of [
			[],
			["bazel"],
			["fastcheck"],
			["fulltest"],
			["slowtest"],
			["missing"],
			["test:ts", "--affected"],
			["test:rs", "--affected", "--affected"],
			["test:rs", "--unknown"],
			["sdk:test:go:smoke", "--smoke"],
			["build", "--unknown"],
		]) {
			expect(() => publicBazelCommand(args)).toThrow();
		}
	});

	test("retains Rust affected/dry-run and Go smoke selection", () => {
		expect(parseBazelPrimitive(["--", "test:rs", "--affected", "--dry-run"])).toEqual({
			task: "test:rs",
			flags: ["--affected", "--dry-run"],
		});
		expect(parseBazelPrimitive(["sdk:test:go", "--smoke"])).toEqual({
			task: "sdk:test:go",
			flags: ["--smoke"],
		});
		expect(() => parseBazelPrimitive(["sdk:test:go", "--smoke", "--smoke"])).toThrow();
	});

	test("rejects invalid primitive invocations with the original usage exit code", async () => {
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "bazel-primitive.ts"), "fulltest"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const exitCode = await child.exited;
		expect(exitCode).toBe(2);
	});

	test("an owned payload returns the Rust dry-run plan without re-entering Bazel", async () => {
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "bazel-tasks.ts"), "test:rs", "--dry-run"],
			{
				cwd: path.resolve(import.meta.dir, ".."),
				env: { ...process.env, CI: "1", OMP_GATE_BAZEL_PRIMITIVE: "1" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		expect(stdout).toContain("cargo nextest run");
		expect(stdout).toContain("cargo test --doc");
	}, 30_000);
});
