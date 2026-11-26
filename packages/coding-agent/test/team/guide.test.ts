import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { InternalUrlRouter } from "../../src/internal-urls";
import { getDocsDiskRoot } from "../../src/internal-urls/docs-index";

// Read the public runtime resource, not the source Markdown file. This detects
// missing docs collection/bundle entries without pretending to test model behavior.
describe("Team bundled guide delivery", () => {
	it("resolves omp://team.md to substantive guide content", async () => {
		const router = InternalUrlRouter.instance();
		const guide = await router.resolve("omp://team.md");
		expect(guide).toMatchObject({
			contentType: "text/markdown",
			content: expect.stringContaining("/team configure"),
		});
		const onDisk =
			getDocsDiskRoot() === null ? null : path.resolve(import.meta.dir, "../../../../docs-zh-CN/team.md");
		expect(await router.locate("omp://team.md")).toBe(onDisk);
	});
});
