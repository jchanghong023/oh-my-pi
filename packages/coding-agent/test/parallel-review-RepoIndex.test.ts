import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RepoLifecycle } from "../src/repo/lifecycle";
import { RepoService } from "../src/repo/service";
import { invalidateFsScanAfterUncertainWrites, invalidateFsScanAfterWrite } from "../src/tools/fs-cache-invalidation";

const temporary: string[] = [];
const services: RepoService[] = [];
const lifecycles: RepoLifecycle[] = [];

afterEach(async () => {
	for (const lifecycle of lifecycles.splice(0)) lifecycle.dispose();
	for (const service of services.splice(0)) service.close();
	await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

it("refreshes possible partial-write paths while retaining unchecked coverage until full reconciliation", async () => {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-partial-write-"));
	temporary.push(temp);
	const cwd = path.join(temp, "project");
	const agentDir = path.join(temp, "profile");
	await fs.mkdir(cwd);
	const first = path.join(cwd, "first.txt");
	const second = path.join(cwd, "second.txt");
	await Bun.write(first, "beforepartialbeacon\n");
	await Bun.write(second, "unchangedbeacon\n");
	const service = new RepoService({ cwd, agentDir });
	services.push(service);
	await service.build();
	const lifecycle = new RepoLifecycle({ agentDir, getCwd: () => cwd });
	lifecycles.push(lifecycle);
	lifecycle.start();
	await service.reconcile();

	// A multi-file apply writes the first path but rejects before the second.
	await Bun.write(first, "afterpartialbeacon\n");
	const reason = "AST apply failed; preview paths may have been partially written";
	invalidateFsScanAfterUncertainWrites([first, second], reason);
	const pending = await service.status();
	expect(pending.pendingPaths).toEqual(["first.txt", "second.txt"]);
	expect(pending.uncertainReasons).toContain(reason);
	const refreshed = await service.search("afterpartialbeacon");
	expect(refreshed.hits.map(hit => hit.path)).toEqual(["first.txt"]);
	expect(refreshed.coverage.pendingCount).toBe(0);
	expect(refreshed.coverage.unchecked).toBe(true);
	expect(refreshed.coverage.needsReconcile).toBe(true);
	expect((await service.search("beforepartialbeacon")).hits).toEqual([]);
	expect((await service.search("unchangedbeacon")).hits.map(hit => hit.path)).toEqual(["second.txt"]);

	await service.reconcile();
	expect((await service.status()).unchecked).toBe(false);
	await Bun.write(first, "successfulwritebeacon\n");
	invalidateFsScanAfterWrite(first);
	const successful = await service.search("successfulwritebeacon");
	expect(successful.hits.map(hit => hit.path)).toEqual(["first.txt"]);
	expect(successful.coverage.pendingCount).toBe(0);
	expect(successful.coverage.unchecked).toBe(false);
});
