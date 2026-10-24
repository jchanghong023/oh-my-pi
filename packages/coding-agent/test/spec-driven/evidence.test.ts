import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { aggregateSpecEvidence, SpecEvidenceService } from "../../src/spec-driven/evidence";
import { recordSpecCommand } from "../../src/spec-driven/execution-tools";
import type { SpecDrivenStatus, SpecToolRecord } from "../../src/spec-driven/types";

describe("runner-owned command evidence", () => {
	it("preserves a quoted executable, quoted script and shell expressions", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-quoted-evidence-"));
		try {
			const command = `"${process.execPath}" -e "console.log(42)" && "${process.execPath}" -e "console.log('second quoted call')"`;
			const record = await recordSpecCommand({
				cwd,
				command,
				toolCallId: "quoted-real-command",
				artifactDir: path.join(cwd, "change", "checks"),
				context: { runId: "quoted-run", generation: 1, signal: new AbortController().signal },
			});
			expect(record.args.command).toBe(command);
			expect(record.result).toMatchObject({ status: "completed", exitCode: 0, isError: false });
			expect(record.result.stdout).toContain("42");
			expect(record.result.stdout).toContain("second quoted call");
			const raw = JSON.parse(await fs.readFile(record.artifact.path, "utf8"));
			expect(raw.toolCallId).toBe("quoted-real-command");
			expect(raw.result).toEqual(record.result);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("persists cancellation with observed output, never inventing exit zero for an unknown exit", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-cancelled-evidence-"));
		const controller = new AbortController();
		const watcherController = new AbortController();
		let ready: Promise<void> | undefined;
		let pending: Promise<SpecToolRecord> | undefined;
		try {
			const artifactDir = path.join(cwd, "change", "checks");
			// This real subprocess must stay alive until cancellation; fake timers cannot drive its clock.
			const command = `"${process.execPath}" -e "console.log('observed before cancellation'); require('node:fs').writeFileSync('command-started', 'ready'); setInterval(() => {}, 1000)"`;
			const watcher = fs.watch(cwd, {
				signal: AbortSignal.any([watcherController.signal, AbortSignal.timeout(10_000)]),
			});
			ready = (async () => {
				for await (const event of watcher) {
					if (event.filename === "command-started") return;
				}
				throw new Error("Command readiness watcher ended before the child started");
			})();
			// Install a rejection handler immediately, including when command launch fails first.
			void ready.catch(() => undefined);
			pending = recordSpecCommand({
				cwd,
				command,
				toolCallId: "cancelled-real-command",
				artifactDir,
				context: { runId: "cancel-run", generation: 1, signal: controller.signal },
			});
			// Observe child readiness instead of racing cancellation against process creation.
			void pending.catch(() => undefined);
			await Promise.race([
				ready,
				pending.then(
					record => {
						throw new Error(
							`Command exited before cancellation readiness: ${JSON.stringify({
								command,
								result: record.result,
								artifact: record.artifact.path,
							})}`,
						);
					},
					error => {
						throw new Error("Command launch/recording failed before cancellation readiness", { cause: error });
					},
				),
			]);
			controller.abort();
			await expect(pending).resolves.toMatchObject({ result: { isError: true } });
			const record = await pending;
			expect(record.result.exitCode).not.toBe(0);
			expect(["cancelled", "unknown"]).toContain(record.result.status);
			expect(record.result.stdout).toContain("observed before cancellation");
			expect(path.relative(artifactDir, record.artifact.path)).toBe(path.basename(record.artifact.path));
			const raw = await fs.readFile(record.artifact.path, "utf8");
			expect(raw).toContain("observed before cancellation");
			expect(raw).toContain("cancelled-real-command");
		} finally {
			controller.abort();
			watcherController.abort();
			await ready?.catch(() => undefined);
			await pending?.catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 15_000);
});

describe("runner-owned selected input evidence", () => {
	it("rejects explicitly selected generated outputs before command admission without shrinking mixed selectors", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-explicit-output-"));
		try {
			const changeDir = path.join(cwd, "change");
			await fs.mkdir(path.join(changeDir, "checks"), { recursive: true });
			await fs.writeFile(path.join(changeDir, "source.ts"), "export const input = 1;");
			await fs.writeFile(path.join(changeDir, "verification.md"), "generated report");
			await fs.writeFile(path.join(changeDir, "checks", "existing.json"), "{}");
			const service = new SpecEvidenceService({
				cwd,
				changeDir,
				owner: {
					actorId: "selector-actor",
					taskId: "selector-task",
					workspace: cwd,
					specificationVersion: "approved-spec",
					planVersion: "approved-plan",
				},
				run: { runId: "selector-run", generation: 1 },
			});
			const context = { runId: "selector-run", generation: 1, signal: new AbortController().signal };
			const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('command-admitted', 'unexpected')"`;
			for (const selected of [
				"change/checks",
				"change/checks/existing.json",
				"change/checks/not-created.json",
				"change/verification.md",
			]) {
				// Parent traversal must not hide an explicit selector visited later in the same approved set.
				const inputPaths = ["change", selected];
				await expect(service.capture({ validationId: "selected-output", inputPaths }, context)).rejects.toThrow(
					"Generated evidence output cannot be explicitly selected",
				);
				await expect(
					service.recordCommand(
						{
							command,
							toolCallId: "must-not-admit",
							inputPaths,
							obligation: { validationId: "selected-output", approvedCommand: command, reason: null },
						},
						context,
					),
				).rejects.toThrow("Generated evidence output cannot be explicitly selected");
			}
			await expect(fs.access(path.join(cwd, "command-admitted"))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps valid parent selection complete while excluding generated descendants and retaining legitimate neighbors", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-parent-input-"));
		try {
			const changeDir = path.join(cwd, "change");
			await fs.mkdir(path.join(changeDir, "checks-neighbor"), { recursive: true });
			await fs.writeFile(path.join(changeDir, "checks-neighbor", "source.ts"), "export const input = 1;");
			await fs.writeFile(path.join(changeDir, "verification.md.input"), "legitimate neighboring input");
			const service = new SpecEvidenceService({
				cwd,
				changeDir,
				owner: {
					actorId: "parent-actor",
					taskId: "parent-task",
					workspace: cwd,
					specificationVersion: "approved-spec",
					planVersion: "approved-plan",
				},
				run: { runId: "parent-run", generation: 1 },
			});
			const context = { runId: "parent-run", generation: 1, signal: new AbortController().signal };
			const identity = await service.capture({ validationId: "parent-input", inputPaths: ["change"] }, context);
			expect(identity.complete).toBe(true);
			expect(identity.inputPaths).toEqual(["change"]);
			expect(identity.entries.map(entry => entry.path)).toEqual([
				"change",
				"change/checks-neighbor",
				"change/checks-neighbor/source.ts",
				"change/verification.md.input",
			]);
			expect(identity.entries.find(entry => entry.path === "change")?.members).toEqual([
				"checks-neighbor",
				"verification.md.input",
			]);
			await fs.writeFile(path.join(changeDir, "checks", "new-output.json"), "{}");
			await fs.writeFile(path.join(changeDir, "verification.md"), "generated report");
			const sealedContext = { runId: "parent-run", generation: 2, signal: AbortSignal.abort() };
			expect(await service.revalidate(sealedContext)).toEqual({ taskIds: [], reasons: [], overall: false });
			await fs.writeFile(path.join(changeDir, "verification.md.input"), "changed legitimate input");
			const invalidation = await service.revalidate(sealedContext);
			expect(invalidation.taskIds).toEqual(["parent-task"]);
			expect(invalidation.reasons).toHaveLength(1);
			expect(invalidation.overall).toBe(false);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

describe("aggregate runner-owned evidence", () => {
	it("publishes two real owners with current status and sealed cancelled history without inventing acceptance", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-aggregate-"));
		const controller = new AbortController();
		const watcherController = new AbortController();
		let ready: Promise<void> | undefined;
		let pending: Promise<SpecToolRecord> | undefined;
		try {
			const changeDir = path.join(cwd, "change");
			const source = path.join(cwd, "source");
			const target = path.join(cwd, "target");
			await fs.mkdir(source);
			await fs.mkdir(target);
			await fs.writeFile(path.join(source, "input.txt"), "source input");
			await fs.writeFile(path.join(target, "input.txt"), "integrated input");
			const services = [source, target].map(
				(workspace, index) =>
					new SpecEvidenceService({
						cwd: workspace,
						changeDir,
						owner: {
							actorId: `actor-${index}`,
							taskId: "task-1",
							workspace,
							specificationVersion: "spec-1",
							planVersion: "plan-1",
						},
						run: { runId: "aggregate-run", generation: index + 1 },
					}),
			);
			const watcher = fs.watch(source, {
				signal: AbortSignal.any([watcherController.signal, AbortSignal.timeout(10_000)]),
			});
			ready = (async () => {
				for await (const event of watcher) if (event.filename === "started") return;
				throw new Error("Source readiness watcher ended");
			})();
			void ready.catch(() => undefined);
			// A real child must remain alive until its readiness event; fake timers cannot control that process.
			const cancelledCommand = `"${process.execPath}" -e "console.log('source history'); require('node:fs').writeFileSync('started', 'ready'); setInterval(() => {}, 1000)"`;
			pending = services[0].recordCommand(
				{
					command: cancelledCommand,
					toolCallId: "source-command",
					inputPaths: ["input.txt"],
					obligation: { validationId: "source-validation", approvedCommand: cancelledCommand, reason: null },
				},
				{ runId: "aggregate-run", generation: 1, signal: controller.signal },
			);
			void pending.catch(() => undefined);
			await Promise.race([
				ready,
				pending.then(() => {
					throw new Error("Source exited before cancellation");
				}),
			]);
			controller.abort();
			const cancelled = await pending;
			const currentCommand = `"${process.execPath}" -e "console.log('target current')"`;
			const current = await services[1].recordCommand(
				{
					command: currentCommand,
					toolCallId: "target-command",
					inputPaths: ["input.txt"],
					obligation: { validationId: "target-validation", approvedCommand: currentCommand, reason: null },
				},
				{ runId: "aggregate-run", generation: 2, signal: new AbortController().signal },
			);
			const context = { runId: "aggregate-run", generation: 2, signal: AbortSignal.abort() };
			const status: SpecDrivenStatus = {
				phase: "awaiting-acceptance",
				generation: 2,
				paused: true,
				questions: [],
				reviews: [],
				pendingClosure: ["sync", "archive"],
				tasks: [
					{
						id: "task-1",
						fingerprint: "task-fingerprint",
						specificationVersion: "spec-1",
						planVersion: "plan-1",
						status: "verified",
						records: [current],
						validatedIds: ["target-validation"],
						commits: [
							{
								base: "source-base",
								head: "target-head",
								taskId: "task-1",
								paths: ["input.txt"],
								reviewPackage: "review-package",
							},
						],
						review: {
							id: "review-1",
							kind: "task",
							model: "isolated-review",
							sameModelIndependent: true,
							revision: 0,
							findings: [
								{
									id: "finding-1",
									severity: "minor",
									issue: "observed finding",
									evidence: "actual supplied review",
									taskIds: ["task-1"],
								},
							],
						},
					},
				],
			};
			await aggregateSpecEvidence(services, status, context);
			const report = await fs.readFile(path.join(changeDir, "verification.md"), "utf8");
			expect(report).toContain(cancelledCommand.replaceAll("\\", "\\\\").replaceAll('"', '\\"'));
			expect(report).toContain(current.id);
			expect(report).toContain(cancelled.id);
			expect(report).toContain(`exit ${cancelled.result.exitCode ?? "unknown"}`);
			expect(cancelled.result.exitCode).not.toBe(0);
			expect(report).toContain('"acceptanceVersion": null');
			expect(report).toContain("finding-1");
			expect(report).toContain("source-base");
			expect(report).toContain("target-head");
			expect(report).not.toContain(`](${changeDir}`);
			const rawLink = report.match(/\[Combined raw observations, status, reviews and commits\]\(([^)]+)\)/)?.[1];
			expect(rawLink).toBeDefined();
			const raw = JSON.parse(await fs.readFile(path.join(changeDir, rawLink!), "utf8"));
			expect(raw.snapshots.map((snapshot: { owner: { actorId: string } }) => snapshot.owner.actorId)).toEqual([
				"actor-0",
				"actor-1",
			]);
			expect(raw.status).toEqual(status);
			expect(raw.snapshots[0].records[0].result).toEqual(cancelled.result);
			await expect(
				services[0].capture({ validationId: "late", inputPaths: ["input.txt"] }, context),
			).rejects.toThrow("inadmissible generation");
			await expect(aggregateSpecEvidence(services, status, { ...context, runId: "other-run" })).rejects.toThrow(
				"different run",
			);
			await fs.writeFile(current.artifact.path, "tampered bytes");
			await expect(aggregateSpecEvidence(services, status, context)).rejects.toThrow("Raw evidence changed");
			expect(await fs.readFile(path.join(changeDir, "verification.md"), "utf8")).toBe(report);
		} finally {
			controller.abort();
			watcherController.abort();
			await ready?.catch(() => undefined);
			await pending?.catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 15_000);

	it("retains the previous summary and original command bytes when aggregate raw saving fails", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-aggregate-save-"));
		try {
			const changeDir = path.join(cwd, "change");
			await fs.writeFile(path.join(cwd, "input.txt"), "input");
			const service = new SpecEvidenceService({
				cwd,
				changeDir,
				owner: {
					actorId: "save-actor",
					taskId: null,
					workspace: cwd,
					specificationVersion: "spec-1",
					planVersion: "plan-1",
				},
				run: { runId: "save-run", generation: 1 },
			});
			const context = { runId: "save-run", generation: 1, signal: new AbortController().signal };
			const command = `"${process.execPath}" -e "console.log('original command output')"`;
			const record = await service.recordCommand(
				{
					command,
					toolCallId: "save-command",
					inputPaths: ["input.txt"],
					obligation: { validationId: "save-validation", approvedCommand: command, reason: null },
				},
				context,
			);
			const status: SpecDrivenStatus = {
				phase: "validating",
				generation: 1,
				paused: false,
				questions: [],
				tasks: [],
				reviews: [],
				pendingClosure: [],
			};
			await service.flush(status, context);
			const previousReport = await fs.readFile(path.join(changeDir, "verification.md"), "utf8");
			const original = await fs.readFile(record.artifact.path, "utf8");
			const previousFiles = await fs.readdir(path.join(changeDir, "checks"));
			const writeFile = fs.writeFile;
			const failure = spyOn(fs, "writeFile").mockImplementation(async (file, ...args) => {
				if (path.basename(String(file)).startsWith("evidence-")) throw new Error("simulated raw save failure");
				return writeFile(file, ...args);
			});
			try {
				await expect(aggregateSpecEvidence([service], status, context)).rejects.toThrow(
					"Evidence originals could not be saved or verified",
				);
			} finally {
				failure.mockRestore();
			}
			expect(await fs.readFile(path.join(changeDir, "verification.md"), "utf8")).toBe(previousReport);
			expect(await fs.readFile(record.artifact.path, "utf8")).toBe(original);
			expect(await fs.readdir(path.join(changeDir, "checks"))).toEqual(previousFiles);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("relocates verified originals after an actual archive directory rename without recreating the retired source", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-relocate-evidence-"));
		try {
			const changeDir = path.join(cwd, "change");
			const archiveDir = path.join(cwd, "archive");
			await fs.writeFile(path.join(cwd, "input.txt"), "original selected input");
			const service = new SpecEvidenceService({
				cwd,
				changeDir,
				owner: {
					actorId: "archive-actor",
					taskId: "task-archive",
					workspace: cwd,
					specificationVersion: "spec-archive",
					planVersion: "plan-archive",
				},
				run: { runId: "archive-run", generation: 1 },
			});
			const context = { runId: "archive-run", generation: 1, signal: new AbortController().signal };
			const command = `"${process.execPath}" -e "console.log('preserved archive output')"`;
			const record = await service.recordCommand(
				{
					command,
					toolCallId: "archive-command",
					inputPaths: ["input.txt"],
					obligation: { validationId: "archive-validation", approvedCommand: command, reason: null },
				},
				context,
			);
			const status: SpecDrivenStatus = {
				phase: "closing",
				generation: 1,
				paused: false,
				questions: [],
				reviews: [],
				pendingClosure: ["archive"],
				tasks: [
					{
						id: "task-archive",
						fingerprint: "archive-task",
						specificationVersion: "spec-archive",
						planVersion: "plan-archive",
						status: "completed",
						records: [record],
						commits: [],
					},
				],
			};
			await service.flush(status, context);
			const original = await fs.readFile(record.artifact.path, "utf8");
			await fs.rename(changeDir, archiveDir);
			const movedPath = path.join(archiveDir, "checks", path.basename(record.artifact.path));
			await fs.writeFile(movedPath, "changed archive original");
			const sealedContext = { ...context, generation: 2, signal: AbortSignal.abort() };
			await expect(service.relocateOutputs(archiveDir, sealedContext)).rejects.toThrow(
				"Archived raw evidence changed",
			);
			await expect(fs.access(changeDir)).rejects.toMatchObject({ code: "ENOENT" });
			await fs.writeFile(movedPath, original);
			await service.relocateOutputs(archiveDir, sealedContext);
			const [movedRecord] = await service.read([record.id], sealedContext);
			expect(movedRecord.artifact.path).toBe(movedPath);
			expect({ ...movedRecord, artifact: record.artifact }).toEqual(record);
			status.tasks[0].records = [movedRecord];
			status.phase = "completed";
			status.generation = 2;
			status.pendingClosure = [];
			await aggregateSpecEvidence([service], status, sealedContext);
			const report = await fs.readFile(path.join(archiveDir, "verification.md"), "utf8");
			expect(report).toContain("Observed phase: completed");
			const relative = report.match(new RegExp(`\\[${record.id}\\]\\(([^)]+)\\)`))?.[1];
			expect(relative).toBe(`checks/${path.basename(movedPath)}`);
			expect(await fs.readFile(path.join(archiveDir, relative!), "utf8")).toBe(original);
			expect(report).toContain('"pendingClosure": []');
			await expect(fs.access(changeDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
