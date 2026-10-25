import { describe, expect, it } from "bun:test";
import { PipeStreams } from "@oh-my-pi/pi-natives";
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
