import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { PipeStreams } from "@oh-my-pi/pi-natives";
import { JobWidgetRuntime, PipeTextSources } from "../../src/job-widgets";
import { createPipeStreams } from "../../src/job-widgets/pipe-source";

/**
 * A stale native addon is a supported load: the loader keeps the previous
 * release's `.node` beside a newer tree, and classes have no
 * `missingNativeExport` fallback. Bash must then run without stream taps
 * instead of throwing `undefined is not a constructor` from every call.
 */
describe("createPipeStreams", () => {
	it("returns the real stream taps when the addon provides PipeStreams", () => {
		const streams = createPipeStreams();
		expect(streams).toBeInstanceOf(PipeStreams);
		expect(streams?.list()).toEqual([]);
	});

	it("degrades to undefined when the addon predates PipeStreams", () => {
		expect(createPipeStreams(null)).toBeUndefined();
		expect(createPipeStreams({})).toBeUndefined();
	});

	it("degrades to undefined when the constructor throws", () => {
		class Broken {
			constructor() {
				throw new TypeError("native initialisation failed");
			}
		}
		expect(createPipeStreams(Broken)).toBeUndefined();
	});
});

describe("PipeTextSources", () => {
	it("keeps a pipe carrying binary data out of the widget's lines and stage", async () => {
		const streams = new PipeStreams();
		const command = "printf 'compiled\\n' | cat; printf 'ustar\\0\\0\\0\\n\\377\\376\\n' | cat >/dev/null";
		const result = await executeBash(command, { cwd: os.tmpdir(), timeout: 5000, streams });
		expect(result.exitCode).toBe(0);

		const runtime = new JobWidgetRuntime(undefined, Date.now());
		runtime.ingest(new PipeTextSources(streams).list(), true);
		const view = runtime.view({ label: command, authoring: false, lineStage: true });

		expect(view.stage).toBe("compiled");
		expect(runtime.totalLines).toBe(1);
		expect(runtime.samples().map(sample => sample.id)).toEqual(["pipe:1"]);
	});
});
