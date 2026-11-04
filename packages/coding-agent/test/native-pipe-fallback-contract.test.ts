import { expect, it, spyOn } from "bun:test";
import { Settings, resetSettingsForTest } from "../src/config/settings";
import { AsyncJobManager } from "../src/async/job-manager";
import * as widgets from "../src/job-widgets";
import { ProcProtocolHandler } from "../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { BashTool } from "../src/tools/bash";
import type { ToolSession } from "../src/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

it("executes a pipeline without native stream taps and keeps proc status/output readable", async () => {
	using root = TempDir.createSync("@omp-pipe-fallback-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	const streams = spyOn(widgets, "createPipeStreams").mockReturnValue(undefined);
	const manager = new AsyncJobManager({});
	const session = {
		cwd: root.path(),
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: () => "pipe-fallback",
		getAgentId: () => "Main",
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({
			"async.enabled": true,
			"launch.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		}),
	} as ToolSession;
	try {
		const result = await new BashTool(session).execute("pipeline", {
			command: "printf 'pipeline-result\\n' | cat",
			async: true,
		});
		const id = result.details?.async?.jobId;
		if (!id) throw new Error("Expected managed background job");
		const job = manager.getJob(id);
		if (!job) throw new Error("Managed job was not retained");
		await job.promise;
		expect(streams).toHaveBeenCalledTimes(1);
		expect(
			job.status,
			JSON.stringify({ error: job.errorText, result: job.resultText, progress: job.progressText }),
		).toBe("completed");
		expect(job.process?.streams).toBeUndefined();
		expect(job.resultText).toContain("pipeline-result");
		const protocol = new ProcProtocolHandler();
		const fallback = await protocol.resolve(parseInternalUrl(`proc://${id}/streams`), { session });
		expect(fallback.content).toMatch(/no (?:available )?pipe streams/i);
		const status = await protocol.resolve(parseInternalUrl(`proc://${id}`), { session });
		expect(status.content).toContain("pipeline-result");
		expect(job.status).toBe("completed");
	} finally {
		streams.mockRestore();
		await manager.dispose();
		resetSettingsForTest();
	}
});
