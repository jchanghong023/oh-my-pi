import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { Settings } from "../../src/config/settings";
import { createDevWorkbenchHost } from "../../src/dev-workbench/host";
import { startDevWorkbenchServer } from "../../src/dev-workbench/server";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import type {
	DevMaterialRef,
	DevRequirementSnapshot,
	DevNativeUiRequest,
	SpecDocument,
} from "../../src/spec-driven/types";

const markdown =
	"# 业务需求：服务边界 Ω\n\n" +
	[
		"基本信息",
		"业务背景与目标",
		"实际使用场景与现状",
		"期望结果",
		"业务规则与边界",
		"典型例子",
		"业务验收预期",
		"待确认事项",
		"资料来源",
		"业务确认与交接",
	]
		.map(title => `## ${title}\n\n真实资料 Ω。\n`)
		.join("\n");
const html = new TextEncoder().encode("<!doctype html><title>Isolated HTTP boundary consumer</title>");
function acceptedResponse(value: unknown): boolean {
	if (!value || typeof value !== "object" || !("accepted" in value) || typeof value.accepted !== "boolean")
		throw new Error("A native UI acceptance receipt is required");
	return value.accepted;
}
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workbench-http-"));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	for (const directory of ["objects", "refs/heads"])
		await fs.mkdir(path.join(cwd, ".git", directory), { recursive: true });
	await fs.writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(cwd, ".git/config"),
		"[core]\nrepositoryformatversion = 0\nbare = false\nautocrlf = false\n[user]\nname = HTTP Test\nemail = http@example.invalid\n",
	);
	await fs.writeFile(path.join(cwd, "baseline.txt"), "unrelated bytes\n");
	const repo = requireGit(cwd);
	await repo.stageFiles(["baseline.txt"]);
	await repo.commitCreate("fixture", {});
	const settings = await Settings.loadIsolated({
		cwd,
		agentDir,
		inMemory: true,
		overrides: { "compaction.enabled": false, "prewalk.enabled": false, "mcp.startupTimeoutMs": 0 },
	});
	const authStorage = await AuthStorage.create(":memory:");
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings,
		authStorage,
		sessionManager: SessionManager.inMemory(cwd),
		contextFiles: [],
		rules: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		autoTitle: false,
		offline: true,
		bindProcessState: false,
	});
	const host = await createDevWorkbenchHost({ session, settings, cwd });
	const service = await startDevWorkbenchServer(host, {
		offline: false,
		asset: async assetPath => (assetPath === "/" ? { bytes: html, contentType: "text/html; charset=utf-8" } : null),
	});
	host.attachService(service);
	const base = new URL(service.loopbackUrl);
	const initialized = await fetch(new URL("api/browser", base));
	const cookie = initialized.headers.get("set-cookie")?.split(";")[0];
	if (!cookie) throw new Error("Host did not issue a browser identity");
	async function request(route: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
		return fetch(new URL(route, base), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				cookie: cookie!,
				origin: base.origin,
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...extraHeaders,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
	return {
		cwd,
		host,
		session,
		service,
		base,
		cookie,
		request,
		async [Symbol.asyncDispose]() {
			await host.close();
			await service.close();
			await session.dispose();
			authStorage.close();
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

describe("workbench capability HTTP service", () => {
	test("requires its actual capability, host and origin; asset preparation cannot publish a fake ready handle", async () => {
		await using f = await fixture();
		expect(new URL(f.service.url).hostname).toBe("127.0.0.1");
		expect(Number(new URL(f.service.url).port)).toBeGreaterThan(0);
		expect((await fetch(new URL("/api/requirements", f.base))).status).toBe(404);
		expect((await fetch(new URL("api/requirements", f.base))).status).toBe(401);
		expect((await f.request("api/requirements", undefined, { origin: "http://attacker.invalid" })).status).toBe(403);
		expect((await f.request("api/requirements", undefined, { host: "attacker.invalid" })).status).toBe(403);
		expect((await f.request("api/requirements")).status).toBe(200);
		await expect(
			startDevWorkbenchServer(f.host, {
				asset: async () => {
					throw new Error("production assets unavailable");
				},
			}),
		).rejects.toThrow("production assets unavailable");
		expect((await f.request("api/requirements")).status).toBe(200);
	}, 120_000);

	test("composer prediction reads and feedback retain capability, browser and target validation", async () => {
		await using f = await fixture();
		const target = { requirementId: null, sessionId: f.session.sessionId, generation: 0 };
		const body = JSON.stringify({ target });
		expect(
			(
				await fetch(new URL("api/composer-prediction", f.base), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				})
			).status,
		).toBe(401);
		expect(
			(await f.request("api/composer-prediction", { target }, { origin: "http://attacker.invalid" })).status,
		).toBe(403);
		expect((await f.request("api/composer-prediction", { target })).status).toBe(409);
		expect((await f.request("api/composer-prediction", { target, event: "request" })).status).toBe(409);
		expect((await f.request("api/composer-prediction", { target, event: "accepted", rank: -1 })).status).toBe(409);
		expect((await f.request("api/composer-prediction", { target: { ...target, generation: 0.5 } })).status).toBe(409);
		expect(f.host.controller.nativeSessions()).toEqual([]);
		expect(f.session.messages).toEqual([]);
	}, 120_000);

	test("real upload bytes round-trip only through registered materials and imports never modify external sources", async () => {
		{
			await using f = await fixture();
			const created = (await (
				await f.request("api/requirements", { source: "import" })
			).json()) as DevRequirementSnapshot;
			const id = created.record.requirementId;
			const form = new FormData();
			form.set("file", new File([markdown], "business.md", { type: "text/markdown" }));
			const upload = await fetch(new URL(`api/business/${id}`, f.base), {
				method: "POST",
				headers: { cookie: f.cookie, origin: f.base.origin },
				body: form,
			});
			const uploadBody = await upload.text();
			if (upload.status !== 200)
				throw new Error(`First upload HTTP ${upload.status}: ${uploadBody}; requirement=${id}`);
			expect(upload.status).toBe(200);
			const snapshot = (await (await f.request(`api/requirements/${id}`)).json()) as DevRequirementSnapshot;
			expect(snapshot.runtime).toBeNull();
			const material = snapshot.record.materials.find(item => item.kind === "business");
			if (!material) throw new Error("Real uploaded business material was not registered");
			const download = await f.request(`api/materials/${id}/${material.id}`);
			expect(await download.text()).toBe(markdown);
			expect(download.headers.get("content-type")).toStartWith("text/markdown");
			const recordPath = path.join(f.cwd, "docs/dev-requirements", `${id}.json`);
			const storedRecord = await fs.readFile(recordPath, "utf8");
			const proposalPath = path.join(f.cwd, "openspec/changes", snapshot.record.changeId, "proposal.md");
			const proposalContent =
				"# Native proposal\n\n## Why\nActual generated requirements are readable before approval.\n";
			await fs.mkdir(path.dirname(proposalPath), { recursive: true });
			await fs.writeFile(proposalPath, proposalContent);
			const deltaPath = path.join(f.cwd, "openspec/changes", snapshot.record.changeId, "specs/sample/spec.md");
			const deltaContent =
				"# Native delta\n\n## ADDED Requirements\n\n### Requirement: Inspect pending material\nThe pending material is visible before approval.\n";
			await fs.mkdir(path.dirname(deltaPath), { recursive: true });
			await fs.writeFile(deltaPath, deltaContent);
			const listing = await f.request(`api/materials/${id}`);
			const listingBody = await listing.text();
			if (listing.status !== 200) throw new Error(`Material listing HTTP ${listing.status}: ${listingBody}`);
			const materials = JSON.parse(listingBody) as DevMaterialRef[];
			const proposal = materials.find(ref => ref.kind === "proposal");
			if (!proposal) throw new Error(`Actual native proposal was not listed: ${listingBody}`);
			const proposalResponse = await f.request(`api/materials/${id}/${encodeURIComponent(proposal.id)}`);
			expect(await proposalResponse.text()).toBe(proposalContent);
			expect(proposalResponse.headers.get("etag")).toBe(JSON.stringify(proposal.version));
			const delta = materials.find(ref => ref.kind === "delta");
			if (!delta) throw new Error(`Actual native spec delta was not listed: ${listingBody}`);
			expect(await (await f.request(`api/materials/${id}/${encodeURIComponent(delta.id)}`)).text()).toBe(
				deltaContent,
			);
			expect(await fs.readFile(recordPath, "utf8")).toBe(storedRecord);
			const unchanged = (await (await f.request(`api/requirements/${id}`)).json()) as DevRequirementSnapshot;
			expect(unchanged.record).toEqual(snapshot.record);
			expect(unchanged.runtime).toBeNull();
			expect(f.host.controller.nativeSessions()).toEqual([]);
			expect((await f.request(`api/materials/${id}/baseline.txt`)).status).not.toBe(200);
			expect((await f.request("api/materials/%2e%2e/baseline.txt")).status).not.toBe(200);
			expect(
				(await f.request(`api/business/${id}`, { path: "https://attacker.invalid/document.md" })).status,
			).not.toBe(200);
			expect(await fs.readFile(path.join(f.cwd, "baseline.txt"), "utf8")).toBe("unrelated bytes\n");
		}
		{
			await using f = await fixture();
			const created = (await (
				await f.request("api/requirements", { source: "import" })
			).json()) as DevRequirementSnapshot;
			const id = created.record.requirementId;
			const external = path.join(f.cwd, "external.md");
			const externalContent = markdown + "\nExternal source remains external.\n";
			await fs.writeFile(external, externalContent);
			const imported = await f.request(`api/business/${id}`, { kind: "host-path", path: external });
			const importedBody = await imported.text();
			if (imported.status !== 200)
				throw new Error(
					`First host-path import HTTP ${imported.status}: ${importedBody}; requirement=${id}; recordVersion=${created.recordVersion}`,
				);
			expect(imported.status).toBe(200);
			const snapshot = (await (await f.request(`api/requirements/${id}`)).json()) as DevRequirementSnapshot;
			expect(snapshot.runtime).toBeNull();
			const material = snapshot.record.materials.find(item => item.kind === "business");
			if (!material) throw new Error("Real host-path business material was not registered");
			expect(await (await f.request(`api/materials/${id}/${material.id}`)).text()).toBe(externalContent);
			expect(await fs.readFile(external, "utf8")).toBe(externalContent);
			expect(await fs.readFile(path.join(f.cwd, "baseline.txt"), "utf8")).toBe("unrelated bytes\n");
		}
	}, 120_000);

	test("reimport requires exact replacement consent and only changes the demand-owned Markdown", async () => {
		await using f = await fixture();
		const created = (await (
			await f.request("api/requirements", { source: "import" })
		).json()) as DevRequirementSnapshot;
		const id = created.record.requirementId;
		const external = path.join(f.cwd, "external.md");
		await fs.writeFile(external, markdown);
		const first = (await (await f.request(`api/business/${id}`, { path: external })).json()) as SpecDocument;
		const target = path.join(f.cwd, first.path);
		const other = path.join(f.cwd, "docs/business-requirements/other.md");
		await fs.writeFile(other, "Another requirement's bytes.\n");
		const before = (await (await f.request(`api/requirements/${id}`)).json()) as DevRequirementSnapshot;
		const recordPath = path.join(f.cwd, "docs/dev-requirements", `${id}.json`);
		const originalRecord = await fs.readFile(recordPath, "utf8");
		const head = await requireGit(f.cwd).head();
		async function upload(content: string, replaceVersion?: string | File) {
			const form = new FormData();
			form.set("file", new File([content], "replacement.md", { type: "text/markdown" }));
			if (replaceVersion !== undefined) form.set("replaceVersion", replaceVersion);
			return fetch(new URL(`api/business/${id}`, f.base), {
				method: "POST",
				headers: { cookie: f.cookie, origin: f.base.origin },
				body: form,
			});
		}
		for (const response of [
			await upload("Unconfirmed replacement"),
			await f.request(`api/business/${id}`, { path: external }),
		]) {
			expect(response.status).toBe(409);
			const body = await response.text();
			expect(body).toContain("确认");
			expect(body).not.toContain("EEXIST");
		}
		expect((await upload("Stale replacement", "stale-version")).status).toBe(409);
		expect((await f.request(`api/business/${id}`, { path: external, replaceVersion: false })).status).toBe(409);
		expect((await upload("Invalid consent", new File(["version"], "version.txt"))).status).toBe(409);
		expect(await fs.readFile(target, "utf8")).toBe(markdown);
		expect(await fs.readFile(recordPath, "utf8")).toBe(originalRecord);
		const replacementContent = "# Confirmed replacement Ω\n";
		const replaced = await upload(replacementContent, first.version);
		expect(replaced.status).toBe(200);
		const replacement = (await replaced.json()) as SpecDocument;
		expect(replacement.version).not.toBe(first.version);
		expect(await fs.readFile(target, "utf8")).toBe(replacementContent);
		expect(await fs.readFile(external, "utf8")).toBe(markdown);
		expect((await f.request(`api/business/${id}`, { path: external, replaceVersion: first.version })).status).toBe(
			409,
		);
		expect(await fs.readFile(target, "utf8")).toBe(replacementContent);
		const restored = await f.request(`api/business/${id}`, { path: external, replaceVersion: replacement.version });
		expect(restored.status).toBe(200);
		const after = (await (await f.request(`api/requirements/${id}`)).json()) as DevRequirementSnapshot;
		expect(after.record.materials.find(material => material.kind === "business")?.version).toBe(first.version);
		expect({ ...after.record, materials: [] }).toEqual({ ...before.record, materials: [] });
		expect(after.runtime).toBeNull();
		expect(f.host.controller.nativeSessions()).toEqual([]);
		expect(f.session.messages).toEqual([]);
		expect((await requireGit(f.cwd).head()).commit).toBe(head.commit);
		await fs.writeFile(target, "Changed after confirmation.\n");
		expect((await upload("Must not replace edited bytes", first.version)).status).toBe(409);
		expect(await fs.readFile(target, "utf8")).toBe("Changed after confirmation.\n");
		await fs.unlink(target);
		expect((await upload("Must not recreate deleted material", first.version)).status).toBe(409);
		await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(external, "utf8")).toBe(markdown);
		expect(await fs.readFile(other, "utf8")).toBe("Another requirement's bytes.\n");
		expect(await fs.readFile(path.join(f.cwd, "baseline.txt"), "utf8")).toBe("unrelated bytes\n");
	}, 120_000);

	test("native human UI resolves through HTTP once and ordinary root is not rebound", async () => {
		await using f = await fixture();
		const sessionId = f.session.sessionId;
		const target = { requirementId: "registered-native-wait", sessionId, generation: 9 };
		const ui = f.host.nativeUi.createContext(() => target);
		const waiting = ui.confirm("Native permission", "Exact native operation");
		const pending = (await (await f.request("api/native-ui")).json()) as DevNativeUiRequest[];
		expect(pending).toHaveLength(1);
		const bad = await (
			await f.request("api/native-ui-response", { ...pending[0], generation: 8, value: true })
		).json();
		expect(acceptedResponse(bad)).toBe(false);
		const response = await (await f.request("api/native-ui-response", { ...pending[0], value: false })).json();
		expect(response).toEqual({ accepted: true });
		expect(await waiting).toBe(false);
		expect(
			acceptedResponse(await (await f.request("api/native-ui-response", { ...pending[0], value: true })).json()),
		).toBe(false);
		expect(f.session.sessionId).toBe(sessionId);
		expect(f.session.messages).toEqual([]);
	}, 120_000);

	test("websocket close releases only subscriptions and reconnect reads facts without replay", async () => {
		await using f = await fixture();
		const created = (await (
			await f.request("api/requirements", { source: "import" })
		).json()) as DevRequirementSnapshot;
		async function connection() {
			const first = Promise.withResolvers<{ t: string; requirements: DevRequirementSnapshot[] }>();
			const ended = Promise.withResolvers<void>();
			const url = new URL("api/events", f.base);
			url.protocol = "ws:";
			url.searchParams.set("requirementId", created.record.requirementId);
			const socket = new WebSocket(url, { headers: { Cookie: f.cookie, Origin: f.base.origin } });
			socket.addEventListener("message", event => {
				const frame = JSON.parse(String(event.data));
				if (frame.t === "requirements") first.resolve(frame);
			});
			socket.addEventListener("error", () => first.reject(new Error("Native events socket failed")));
			socket.addEventListener("close", () => ended.resolve());
			const frame = await first.promise;
			return {
				frame,
				async close() {
					socket.close();
					await ended.promise;
				},
			};
		}
		const first = await connection();
		expect(first.frame.requirements[0].runtime).toBeNull();
		await first.close();
		const second = await connection();
		expect(second.frame.requirements[0].record.decisions).toEqual([]);
		await second.close();
		expect(f.host.controller.nativeSessions()).toEqual([]);
		expect((await f.host.controller.getRequirement(created.record.requirementId)).record.lifecycle).toBe("active");
	}, 120_000);
});
