import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { archiveWorkspaceProducts, restoreWorkspaceProducts } from "./bazel-workspace-products";

const roots: string[] = [];
async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-products-"));
	roots.push(root);
	return root;
}
async function put(root: string, filename: string, content: string): Promise<void> {
	await fs.mkdir(path.dirname(path.join(root, filename)), { recursive: true });
	await Bun.write(path.join(root, filename), content);
}
async function text(root: string, filename: string): Promise<string> {
	return Bun.file(path.join(root, filename)).text();
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("workspace product archive consumers", () => {
	test("restores deleted client products repeatedly and clears only its own stale tree", async () => {
		const root = await fixture();
		await put(root, "packages/stats/dist/client/index.html", "<html>client</html>");
		await put(root, "packages/stats/dist/client/assets/client.js", "console.log('client')");
		await put(root, "packages/stats/dist/server.js", "server-owned");
		const archive = path.join(root, "stats.tar");
		await archiveWorkspaceProducts(root, "stats", archive);
		for (let attempt = 0; attempt < 2; attempt++) {
			await fs.rm(path.join(root, "packages/stats/dist/client"), { recursive: true, force: true });
			await put(root, "packages/stats/dist/client/stale.js", "stale");
			await restoreWorkspaceProducts(root, "stats", archive);
			expect(await text(root, "packages/stats/dist/client/index.html")).toBe("<html>client</html>");
			expect(await text(root, "packages/stats/dist/client/assets/client.js")).toBe("console.log('client')");
			expect(await Bun.file(path.join(root, "packages/stats/dist/client/stale.js")).exists()).toBe(false);
			expect(await text(root, "packages/stats/dist/server.js")).toBe("server-owned");
		}
	});

	test("restores both robomp trees while preserving the checkout static anchor", async () => {
		const root = await fixture();
		await put(root, "python/robomp/web/dist/index.html", "web");
		await put(root, "python/robomp/src/static/index.html", "web");
		await put(root, "python/robomp/src/static/.gitkeep", "original anchor");
		const archive = path.join(root, "robomp.tar");
		await archiveWorkspaceProducts(root, "robomp-web", archive);
		await put(root, "python/robomp/src/static/.gitkeep", "checkout anchor");
		await put(root, "python/robomp/src/static/stale.js", "stale");
		await fs.rm(path.join(root, "python/robomp/web/dist"), { recursive: true });
		await restoreWorkspaceProducts(root, "robomp-web", archive);
		expect(await text(root, "python/robomp/web/dist/index.html")).toBe("web");
		expect(await text(root, "python/robomp/src/static/index.html")).toBe("web");
		expect(await text(root, "python/robomp/src/static/.gitkeep")).toBe("checkout anchor");
		expect(await Bun.file(path.join(root, "python/robomp/src/static/stale.js")).exists()).toBe(false);
	});

	test("preserves CLI bytes, executable permissions, tool views and the empty stats placeholder without owning dist", async () => {
		const root = await fixture();
		const cross = process.env.CROSS_TARGET;
		const windows = cross ? /^(?:win32|windows)-/.test(cross) : process.platform === "win32";
		const binary = `packages/coding-agent/dist/omp${cross ? `-${cross}` : ""}${windows ? ".exe" : ""}`;
		const views = "packages/coding-agent/src/export/html/tool-views.generated.js";
		const placeholder = "packages/stats/src/embedded-client.generated.txt";
		const payload = "#!/bin/sh\n# real creation stamp: 2026-10-20T08:30Z\nprintf cached-product\n";
		await put(root, binary, payload);
		await fs.chmod(path.join(root, binary), 0o755);
		await put(root, views, "export const view = 'generated';");
		await put(root, placeholder, "");
		await put(root, "packages/coding-agent/dist/unowned.js", "keep");
		const archive = path.join(root, "cli.tar");
		await archiveWorkspaceProducts(root, "coding-agent", archive);
		await fs.rm(path.join(root, binary));
		await put(root, views, "stale");
		await put(root, placeholder, "stale embedded archive");
		await restoreWorkspaceProducts(root, "coding-agent", archive);
		expect(await text(root, binary)).toBe(payload);
		expect(await text(root, views)).toBe("export const view = 'generated';");
		expect(await text(root, placeholder)).toBe("");
		expect(await text(root, "packages/coding-agent/dist/unowned.js")).toBe("keep");
		if (process.platform !== "win32") expect((await fs.stat(path.join(root, binary))).mode & 0o111).toBe(0o111);
	});

	test("rejects archive ownership violations before deleting current products", async () => {
		const root = await fixture();
		await put(root, "packages/stats/dist/client/index.html", "existing client");
		const filename = "packages/coding-agent/dist/unowned.js";
		const archive = path.join(root, "invalid.tar");
		await Bun.write(
			archive,
			await new Bun.Archive({
				[filename]: "unowned",
				"__omp_workspace_products.json": JSON.stringify({
					version: 1,
					product: "stats",
					modes: { [filename]: 0o644 },
				}),
			}).bytes(),
		);
		await expect(restoreWorkspaceProducts(root, "stats", archive)).rejects.toThrow("unowned path");
		expect(await text(root, "packages/stats/dist/client/index.html")).toBe("existing client");
	});
});
