import { afterEach, describe, expect, test, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { OmpSpecDrivenBridge } from "../../src/modes/zcode/spec-driven";
import {
	v4ConversationWorkflowRunArtifactReadParamsSchema,
	v4ConversationWorkflowRunArtifactsResultSchema,
} from "../../src/modes/zcode/schema";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "../../src/modes/zcode/sessions";
import * as controllers from "../../src/spec-driven/controller";
import type { SpecControllerObservation } from "../../src/spec-driven/controller";

afterEach(() => vi.restoreAllMocks());
const digest = (content: string) => createHash("sha256").update(content).digest("hex");

describe("Dev artifact version wire contract", () => {
	// Exercise seventeen actual captures and a new bridge, not a hand-built metadata response.
	test("retains every captured version beyond sixteen across cold queries", async () => {
		await using root = await TempDir.create("@zcode-spec-versions-");
		const cwd = await fs.realpath(root.path());
		let publish: ((observation: SpecControllerObservation) => void) | undefined;
		vi.spyOn(controllers, "observeSpecDrivenController").mockImplementation((_scope, listener) => {
			publish = listener;
			return () => {};
		});
		const record = {
			id: "version-session",
			cwd,
			session: { sessionGeneration: 0, sessionManager: { getSessionFile: () => root.join("session.jsonl") } },
		} as unknown as ZCodeSessionRecord;
		const manager = {
			get: () => record,
			read: async () => ({ cwd, info: { path: root.join("session.jsonl") } }),
		} as unknown as ZCodeSessionManager;
		const bridge = new OmpSpecDrivenBridge(manager);
		bridge.attach(record, () => {});
		const observation: SpecControllerObservation = {
			runId: "version-run",
			cwd,
			createdAt: 1,
			updatedAt: 1,
			active: false,
			released: false,
			disposed: false,
			teamMutable: false,
			approvals: {},
			status: {
				changeId: "versions",
				phase: "executing",
				entryPhase: "requirements",
				businessCompleted: false,
				awaitingAcceptance: true,
				useTeam: false,
				generation: 0,
				paths: { requirements: [], solution: "solution.json", plan: "plan.md", report: "report.md" },
			},
			interaction: { mode: "dev", actions: [] },
		};
		try {
			for (let version = 1; version <= 17; version++) {
				const content = `# Real report ${version}\n真实字节版本 ${version}\n`;
				await fs.writeFile(root.join("report.md"), content);
				observation.updatedAt = version;
				observation.status.report = { path: "report.md", content, version: digest(content) };
				if (!publish) throw new Error("Native observer was not attached");
				publish(observation);
				const run = (await bridge.runs(record.id))[0];
				expect(run?.spec.materials.find(item => item.id === "report")?.version).toBe(version);
			}
		} finally {
			await bridge.dispose();
		}
		const cold = new OmpSpecDrivenBridge(manager);
		try {
			const result = v4ConversationWorkflowRunArtifactsResultSchema.parse(
				await cold.artifacts(record.id, "version-run"),
			);
			const report = result.artifacts.find(item => item.id === "report");
			expect(report?.version).toBe(17);
			expect(report?.versions.map(item => item.version)).toEqual(
				Array.from({ length: 17 }, (_, index) => index + 1),
			);
			const current = await cold.artifactRead({
				sessionId: record.id,
				runId: "version-run",
				artifactId: "report",
				version: 17,
				offset: 0,
				limit: 4096,
			});
			expect(Buffer.from(current!.dataBase64, "base64").toString()).toBe("# Real report 17\n真实字节版本 17\n");
			const stored = JSON.parse(await fs.readFile(root.join(".omp/spec-sessions/version-run/zcode.json"), "utf8"));
			expect(stored.artifacts.find((item: { id: string }) => item.id === "report").versions).toHaveLength(17);
			expect(JSON.stringify(stored)).not.toContain("真实字节版本");
		} finally {
			await cold.dispose();
		}
	});

	// Only positive safe integers extend the baseline version domain; identity/range rules stay strict.
	test.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects out-of-domain version %s before byte reads",
		version => {
			const input = {
				sessionId: "version-session",
				runId: "version-run",
				artifactId: "report",
				version,
				offset: 0,
				limit: 4096,
			};
			expect(v4ConversationWorkflowRunArtifactReadParamsSchema.safeParse(input).success).toBe(false);
		},
	);
});
