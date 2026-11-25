import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../../src/internal-urls";

// Read the public runtime resource, not the source Markdown file. This detects
// missing docs collection/bundle entries without pretending to test model behavior.
describe("Team bundled guide delivery", () => {
	it("resolves omp://team.md to substantive guide content", async () => {
		const router = InternalUrlRouter.instance();
		const guide = await router.resolve("omp://team.md");
		expect(guide.content.trim().length).toBeGreaterThan(100);
	});
});
