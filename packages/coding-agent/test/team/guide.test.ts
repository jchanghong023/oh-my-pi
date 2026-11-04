import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "../../src/internal-urls";

// Read the public runtime resource, not the source Markdown file. This detects
// missing docs collection/bundle entries without pretending to test model behavior.
describe("Team bundled guide delivery", () => {
	it("discovers and reads the Team guide through both public documentation URI forms", async () => {
		const router = InternalUrlRouter.instance();
		const listing = await router.resolve("omp://docs");
		expect(listing.content).toContain("team.md");
		const direct = await router.resolve("omp://team.md");
		const prefixed = await router.resolve("omp://docs/team.md");
		expect(prefixed.content).toBe(direct.content);
		expect(direct.content).toContain("/team configure");
		expect(direct.content).toContain("team.members");
		expect(direct.content).toContain("config.yml");
		expect(direct.content).toContain("models.yml");
		expect(direct.content).toContain("不触发实施");
	});
});
