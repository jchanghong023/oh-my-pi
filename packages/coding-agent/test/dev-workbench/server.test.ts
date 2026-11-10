import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { createDevWorkbenchHost } from "../../src/dev-workbench/host";
import { startDevWorkbenchServer } from "../../src/dev-workbench/server";
import { nativeWebGuiQuestions } from "../../src/dev-workbench/native/native-interactions";
import type {
	DevNativePredictionSnapshot,
	DevNativeSurfaceTarget,
} from "../../src/dev-workbench/native/native-surface-types";
import {
	buildRequirementSnapshot,
	canonicalJson,
	decodeRequirementPackage,
	encodeRequirementPackage,
} from "../../src/dev-workbench/requirement-package";
import type {
	DevMaterialView,
	DevPackageManifest,
	DevRequirementContent,
	DevWorkflowResult,
	DevWorkflowView,
} from "../../src/dev-workbench/workflow-types";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createProviderFixture } from "../spec-driven/provider-fixture";
import { workflowGit } from "./workflow-fixture";
import { registeredFixtureProject } from "./fixture";

const html = new TextEncoder().encode("<!doctype html><title>Isolated HTTP boundary consumer</title>");
const markdown =
	"# 服务边界 Ω\n\n## Context\nKeep actual source bytes.\n\n## Rules\nTrim outer whitespace and preserve inner whitespace.\n\n## Acceptance\nEmpty names produce world; Unicode Ω remains intact.\n";

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
	const provider = createProviderFixture({
		reply: () => ({ text: "No HTTP boundary test authorizes a native turn" }),
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
	);
	const settings = await Settings.loadIsolated({
		cwd,
		agentDir,
		inMemory: true,
		overrides: {
			modelRoles: { default: "deepseek/chat-a", smol: "deepseek/chat-a" },
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"mcp.startupTimeoutMs": 0,
			"composer.predictions": false,
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = registry.find("deepseek", "chat-a");
	if (!model) throw new Error("Isolated HTTP fixture model unavailable");
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings,
		authStorage,
		modelRegistry: registry,
		model,
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
	const clientId = "http-test-page";
	const initialized = await fetch(new URL("api/browser", base), { headers: { "X-Dev-Client": clientId } });
	const cookie = initialized.headers.get("set-cookie")?.split(";", 1)[0];
	if (!cookie) throw new Error("Host did not issue a browser identity");
	const { browserId } = (await initialized.json()) as { browserId: string };
	const pageId = `${browserId}:${clientId}`;
	async function request(route: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
		return fetch(new URL(route, base), {
			method: body === undefined ? "GET" : "POST",
			headers: {
				cookie: cookie!,
				origin: base.origin,
				"X-Dev-Client": clientId,
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...extraHeaders,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
	const initialResponse = await request("workflow");
	if (!initialResponse.ok) throw new Error(await initialResponse.text());
	const initialView = (await initialResponse.json()) as DevWorkflowView;
	const project = await registeredFixtureProject(initialView.projects, cwd);
	const projectId = project.id;
	const selected = await request("workflow/bind", { projectId });
	if (!selected.ok) throw new Error(await selected.text());
	async function view(extraHeaders: Record<string, string> = {}): Promise<DevWorkflowView> {
		const info = await request("server-info", undefined, extraHeaders);
		if (!info.ok) throw new Error(await info.text());
		const { binding } = (await info.json()) as {
			binding?: { projectId: string; irId?: string; srId?: string };
		};
		if (!binding) throw new Error("HTTP fixture page has no project binding");
		// Workflow GETs select only explicit identities, not a shared current object.
		const params = new URLSearchParams({ projectId: binding.projectId });
		if (binding.irId) params.set("irId", binding.irId);
		if (binding.srId) params.set("srId", binding.srId);
		const response = await request(`workflow?${params}`, undefined, extraHeaders);
		if (!response.ok) throw new Error(await response.text());
		return (await response.json()) as DevWorkflowView;
	}
	async function create(type: "createBrowserDraft" | "createLocalDraft" = "createBrowserDraft") {
		let current = await view();
		let response = await request("workflow/command", {
			type: "createRelease",
			projectId,
			title: "HTTP acceptance",
			operationId: crypto.randomUUID(),
			expectedRevision: current.revision,
		});
		if (!response.ok) throw new Error(await response.text());
		current = await view();
		const releaseId = current.releases.at(-1)!.id;
		response = await request("workflow/command", {
			type,
			projectId,
			releaseId,
			operationId: crypto.randomUUID(),
			expectedRevision: current.revision,
		});
		if (!response.ok) throw new Error(await response.text());
		const created = (await response.json()) as DevWorkflowResult;
		const ref = { projectId, irId: created.irId! };
		expect((await request("workflow/bind", ref)).ok).toBe(true);
		return { ...ref, releaseId };
	}
	return {
		cwd,
		host,
		projectId,
		session,
		provider,
		service,
		base,
		cookie,
		clientId,
		pageId,
		request,
		view,
		create,
		async [Symbol.asyncDispose]() {
			await host.close();
			await service.close();
			await session.dispose();
			await registry.awaitBackgroundRefresh();
			authStorage.close();
			await provider[Symbol.asyncDispose]();
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

interface PackageSource {
	cwd: string;
	view(): Promise<DevWorkflowView>;
}

/** An actual encoded transport package from another reviewed source, not native actor output. */
async function packageBytes(f: PackageSource) {
	const project = await registeredFixtureProject((await f.view()).projects, f.cwd);
	const irId = "transport-ir";
	const content: DevRequirementContent = {
		title: "Greeting boundary Ω",
		document: { path: `docs/dev/requirements/${irId}/ir.md`, content: markdown },
		srs: [
			{
				id: "transport-sr",
				title: "Greeting rules",
				document: { path: `docs/dev/requirements/${irId}/sr.md`, content: markdown },
			},
		],
		attachments: [{ path: `docs/dev/requirements/${irId}/evidence.txt`, content: "Uploaded source Ω\n" }],
	};
	content.attachments.push({
		path: `docs/dev/requirements/${irId}/requirements.json`,
		content: canonicalJson({
			version: 1,
			irId,
			title: content.title,
			documentPath: content.document.path,
			srs: content.srs.map(sr => ({ id: sr.id, title: sr.title, documentPath: sr.document.path })),
		}),
	});
	const snapshot = buildRequirementSnapshot("transport-project", irId, content);
	const createdAt = new Date().toISOString();
	const manifest: DevPackageManifest = {
		format: "omp-dev-requirements",
		version: 1,
		packageId: "transport-package",
		sourceProjectId: "transport-project",
		repositoryId: project.repositoryId,
		irId,
		releaseId: "transport-release",
		createdAt,
		snapshot,
		confirmation: { operationId: "transport-confirmation", snapshotDigest: snapshot.digest, confirmedAt: createdAt },
		review: {
			id: "transport-review",
			snapshotDigest: snapshot.digest,
			passed: true,
			report: "Imported source review evidence",
			reviewer: { sessionId: "transport-reviewer", role: "reviewer" },
			createdAt,
		},
		files: snapshot.files,
	};
	const files = new Map(
		[content.document, ...content.srs.map(sr => sr.document), ...content.attachments].map(document => [
			document.path,
			new TextEncoder().encode(String(document.content)),
		]),
	);
	const target = path.join(f.cwd, "source.zip");
	await encodeRequirementPackage(target, manifest, files);
	return { target, bytes: await fs.readFile(target), manifest, files };
}

describe("workflow capability HTTP service", () => {
	test("capability, browser, Host, Origin and fetch-site gates run before workflow access; failed assets cannot publish readiness", async () => {
		await using f = await fixture();
		expect(new URL(f.service.url).hostname).toBe("127.0.0.1");
		expect(Number(new URL(f.service.url).port)).toBeGreaterThan(0);
		expect((await fetch(new URL("/workflow", f.base))).status).toBe(404);
		expect((await fetch(new URL("workflow", f.base))).status).toBe(401);
		const deniedHeaders: Array<Record<string, string>> = [
			{ origin: "http://attacker.invalid" },
			{ host: "attacker.invalid" },
			{ "sec-fetch-site": "cross-site" },
		];
		for (const headers of deniedHeaders) expect((await f.request("workflow", undefined, headers)).status).toBe(403);
		expect((await f.request("workflow")).status).toBe(200);
		const unselected = (await (await f.request("workflow")).json()) as DevWorkflowView;
		expect(unselected.currentProjectId).toBeUndefined();
		expect(unselected.sessions).toEqual([]);
		const projectView = await f.view();
		expect(projectView.currentProjectId).toBe(f.projectId);
		expect(projectView.selected).toBeUndefined();
		expect(projectView.sessions).toEqual([]);
		const projectInfo = (await (await f.request("session-info")).json()) as {
			bound: boolean;
			binding: { projectId: string; irId?: string };
			sessionId?: string;
		};
		expect(projectInfo.binding.projectId).toBe(f.projectId);
		expect(projectInfo.binding.irId).toBeUndefined();
		expect(projectInfo.bound).toBe(false);
		expect(projectInfo.sessionId).toBeUndefined();
		const bootstrap = await f.request("api/browser");
		expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly");
		expect(bootstrap.headers.get("set-cookie")).toContain("SameSite=Strict");
		await expect(
			startDevWorkbenchServer(f.host, {
				asset: async () => {
					throw new Error("production assets unavailable");
				},
			}),
		).rejects.toThrow("production assets unavailable");
		expect((await f.request("workflow")).status).toBe(200);
		expect(f.session.messages).toEqual([]);
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("JSON command validation, duplicate query rejection and stale bindings do not create native turns", async () => {
		await using f = await fixture();
		expect((await f.request("workflow/command", {})).status).toBe(400);
		expect(
			(await f.request("workflow/command", { type: "createRelease", operationId: "invalid", expectedRevision: 0.5 }))
				.status,
		).toBe(400);
		expect((await f.request("workflow?projectId=one&projectId=two")).status).toBe(400);
		expect(
			(await f.request("workflow/bind", { projectId: (await f.view()).currentProjectId, irId: "unknown" })).ok,
		).toBe(false);
		const { projectId, irId } = await f.create();
		const current = await f.view();
		const beforeRequests = f.provider.requests.length;
		expect(
			(
				await f.request("workflow/input", {
					projectId,
					irId,
					text: "must not execute",
					sessionId: "foreign",
					round: 900,
					expectedRevision: current.revision,
					operationId: crypto.randomUUID(),
				})
			).status,
		).toBe(409);
		const after = await f.view();
		expect(after.revision).toBe(current.revision);
		expect(after.sessions).toEqual(current.sessions);
		expect(after.running).toEqual(current.running);
		expect(f.provider.requests).toHaveLength(beforeRequests);
		expect(f.session.messages).toEqual([]);
	}, 120_000);

	test("two pages sharing one browser cookie keep independent object selection when one page clears to its project", async () => {
		await using f = await fixture();
		const first = await f.create();
		const otherPage = { "X-Dev-Client": "independent-page" };
		const unboundInfo = (await (
			await f.request(`session-info?${new URLSearchParams({ projectId: first.projectId })}`, undefined, otherPage)
		).json()) as { bound: boolean; binding?: unknown; sessionId?: string };
		expect(unboundInfo.binding).toBeUndefined();
		expect(unboundInfo.bound).toBe(false);
		expect(unboundInfo.sessionId).toBeUndefined();
		expect((await f.request("workflow/bind", { projectId: first.projectId, irId: first.irId }, otherPage)).ok).toBe(
			true,
		);
		const second = await f.create();
		const beforeClear = await f.view();
		const beforeRequests = f.provider.requests.length;
		const firstInfo = (await (await f.request("server-info", undefined, otherPage)).json()) as {
			binding: { projectId: string; irId?: string };
		};
		const secondInfo = (await (await f.request("server-info")).json()) as {
			binding: { projectId: string; irId?: string };
		};
		expect(firstInfo.binding.irId).toBe(first.irId);
		expect(secondInfo.binding.irId).toBe(second.irId);
		expect((await f.view(otherPage)).selected).toMatchObject({ projectId: first.projectId, irId: first.irId });
		expect((await f.request("workflow/bind", { projectId: first.projectId }, otherPage)).ok).toBe(true);
		const cleared = (await (await f.request("server-info", undefined, otherPage)).json()) as {
			binding: { irId?: string; sessionId?: string };
		};
		expect(cleared.binding.irId).toBeUndefined();
		expect(cleared.binding.sessionId).toBeUndefined();
		const clearedView = await f.view(otherPage);
		expect(clearedView.currentProjectId).toBe(first.projectId);
		expect(clearedView.selected).toBeUndefined();
		expect(clearedView.revision).toBe(beforeClear.revision);
		expect(clearedView.sessions).toEqual(beforeClear.sessions);
		expect(clearedView.running).toEqual(beforeClear.running);
		expect(((await (await f.request("server-info")).json()) as { binding: { irId: string } }).binding.irId).toBe(
			second.irId,
		);
		const selectedView = await f.view();
		expect(selectedView.selected).toMatchObject({ projectId: second.projectId, irId: second.irId });
		expect(selectedView.drafts.map(draft => draft.id)).toEqual(expect.arrayContaining([first.irId, second.irId]));
		expect(selectedView.revision).toBe(beforeClear.revision);
		expect(selectedView.sessions).toEqual(beforeClear.sessions);
		expect(selectedView.running).toEqual(beforeClear.running);
		expect(f.provider.requests).toHaveLength(beforeRequests);
	}, 120_000);

	test("ZIP bytes are validated before Git effects; valid import round-trips only registered readonly material and never changes the upload", async () => {
		await using f = await fixture();
		const { projectId, releaseId } = await f.create();
		const source = await packageBytes(f);
		const initialHead = await requireGit(f.cwd).headSha();
		const worktrees = await workflowGit(f.cwd, ["worktree", "list", "--porcelain"]);
		const upload = (bytes: Uint8Array) =>
			fetch(new URL(`workflow/packages?projectId=${projectId}`, f.base), {
				method: "POST",
				headers: {
					cookie: f.cookie,
					origin: f.base.origin,
					"X-Dev-Client": f.clientId,
					"content-type": "application/zip",
				},
				body: bytes,
			});
		const before = await f.view();
		const beforeRequests = f.provider.requests.length;
		expect((await upload(new Uint8Array([0x50, 0x4b, 0x03]))).ok).toBe(false);
		expect((await f.view()).revision).toBe(before.revision);
		expect(await workflowGit(f.cwd, ["worktree", "list", "--porcelain"])).toBe(worktrees);
		const uploaded = await upload(source.bytes);
		expect(uploaded.ok).toBe(true);
		const { packageId } = (await uploaded.json()) as { packageId: string };
		const imported = await f.request("workflow/command", {
			type: "importPackage",
			projectId,
			releaseId,
			packageId,
			operationId: crypto.randomUUID(),
			expectedRevision: before.revision,
		});
		if (!imported.ok) throw new Error(`Import HTTP ${imported.status}: ${await imported.text()}`);
		const after = await f.view();
		const group = after.groups.find(item => item.id === source.manifest.irId);
		if (!group?.worktree) throw new Error("Actual imported worktree missing");
		expect(path.resolve(group.worktree.path)).not.toBe(path.resolve(f.cwd));
		expect(group.origin).toBe("import");
		expect(after.sessions).toEqual(before.sessions);
		expect(after.sessions.some(session => session.irId === group.id)).toBe(false);
		expect(after.running).toEqual(before.running);
		for (const [file, bytes] of source.files) {
			const route = `workflow/material?${new URLSearchParams({ projectId, irId: group.id, path: file })}`;
			const response = await f.request(route);
			expect(response.ok).toBe(true);
			const material = (await response.json()) as DevMaterialView;
			expect(material.content).toBe(new TextDecoder().decode(bytes));
			expect(await fs.readFile(path.join(group.worktree.path, file))).toEqual(Buffer.from(bytes));
			expect((await f.request(route, { content: "must not save" })).status).toBe(404);
		}
		expect(
			(
				await f.request(
					`workflow/material?${new URLSearchParams({ projectId, irId: group.id, path: "baseline.txt" })}`,
				)
			).ok,
		).toBe(false);
		expect(
			(
				await f.request(
					`workflow/material?${new URLSearchParams({ projectId, irId: group.id, path: "../baseline.txt" })}`,
				)
			).ok,
		).toBe(false);
		expect(
			(
				await f.request(
					`workflow/material?${new URLSearchParams({ projectId, irId: "foreign-ir", path: source.manifest.snapshot.documentPath })}`,
				)
			).ok,
		).toBe(false);
		const exported = await f.request(`workflow/package?projectId=${projectId}&irId=${group.id}`);
		expect(exported.headers.get("content-type")).toBe("application/zip");
		const decoded = await decodeRequirementPackage(new Uint8Array(await exported.arrayBuffer()));
		expect(decoded.files).toEqual(source.files);
		expect(await fs.readFile(source.target)).toEqual(source.bytes);
		expect(await fs.readFile(path.join(f.cwd, "baseline.txt"), "utf8")).toBe("unrelated bytes\n");
		expect(await requireGit(f.cwd).headSha()).toBe(initialHead);
		const afterReads = await f.view();
		expect(afterReads.revision).toBe(after.revision);
		expect(afterReads.sessions).toEqual(after.sessions);
		expect(afterReads.running).toEqual(after.running);
		expect(f.provider.requests).toHaveLength(beforeRequests);
		expect(f.session.messages).toEqual([]);
	}, 120_000);

	test("package handles are scoped to their actual browser and cannot authorize a foreign import", async () => {
		await using f = await fixture();
		const { projectId, releaseId } = await f.create();
		const source = await packageBytes(f);
		const uploaded = await fetch(new URL(`workflow/packages?projectId=${projectId}`, f.base), {
			method: "POST",
			headers: {
				cookie: f.cookie,
				origin: f.base.origin,
				"X-Dev-Client": f.clientId,
				"content-type": "application/zip",
			},
			body: source.bytes,
		});
		const { packageId } = (await uploaded.json()) as { packageId: string };
		const bootstrap = await fetch(new URL("api/browser", f.base), { headers: { "X-Dev-Client": f.clientId } });
		const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
		if (!cookie || cookie === f.cookie) throw new Error("Independent browser identity was not issued");
		const before = await f.view();
		expect(
			(
				await f.request(
					"workflow/command",
					{
						type: "importPackage",
						projectId,
						releaseId,
						packageId,
						expectedRevision: before.revision,
						operationId: crypto.randomUUID(),
					},
					{ cookie },
				)
			).status,
		).toBe(409);
		expect((await f.view()).revision).toBe(before.revision);
	}, 120_000);

	test("native surface reads and prediction feedback retain capability, page, round and object validation without requesting a model", async () => {
		await using f = await fixture();
		const { projectId, irId } = await f.create();
		const native = await f.host.workflow.prepare(f.pageId, { projectId, irId });
		const target: DevNativeSurfaceTarget = {
			projectId,
			irId,
			sessionId: native.sessionId,
			phase: native.phase,
			round: native.round,
			clientId: f.clientId,
		};
		const route = `workflow/native-surface?${new URLSearchParams(Object.entries(target).map(([key, value]): [string, string] => [key, String(value)]))}`;
		expect((await fetch(new URL(route, f.base))).status).toBe(401);
		expect((await f.request(route, undefined, { origin: "http://attacker.invalid" })).status).toBe(403);
		const response = await f.request(route);
		expect(response.ok).toBe(true);
		const snapshot = (await response.json()) as {
			target: DevNativeSurfaceTarget;
			prediction: DevNativePredictionSnapshot;
		};
		expect(snapshot.target).toEqual(target);
		expect(snapshot.prediction.choices).toEqual([]);
		expect(
			(await f.request("workflow/native-surface/prediction", { target, action: { type: "request" } })).status,
		).toBe(409);
		expect(
			(
				await f.request("workflow/native-surface/prediction", {
					target,
					action: { type: "accepted", generation: snapshot.prediction.generation, rank: -1 },
				})
			).status,
		).toBe(409);
		expect(
			(
				await f.request("workflow/native-surface/editor", {
					target: { ...target, round: target.round + 1 },
					text: "foreign round",
				})
			).status,
		).toBe(409);
		expect(
			(
				await f.request("workflow/native-surface/editor", {
					target: { ...target, sessionId: "foreign-session" },
					text: "foreign session",
				})
			).status,
		).toBe(409);
		await f.create();
		expect((await f.request(route)).status).toBe(409);
		expect(f.session.messages).toEqual([]);
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("native human UI resolves through the exact bound HTTP surface once without rebinding the ordinary root", async () => {
		await using f = await fixture();
		const { projectId, irId } = await f.create();
		const native = await f.host.workflow.prepare(f.pageId, { projectId, irId });
		const session = (await f.host.workflow.project(projectId)).runtime.session(native);
		const target: DevNativeSurfaceTarget = {
			projectId,
			irId,
			sessionId: native.sessionId,
			phase: native.phase,
			round: native.round,
			clientId: f.clientId,
		};
		const route = `workflow/native-surface?${new URLSearchParams(Object.entries(target).map(([key, value]): [string, string] => [key, String(value)]))}`;
		expect((await f.request(route)).ok).toBe(true);
		const rootId = f.session.sessionId;
		const broker = nativeWebGuiQuestions(session);
		const waiting = broker.ui.confirm("Native permission", "Exact native operation");
		const request = broker.pendingInteractions[0]!;
		const body = { target, requestId: request.interactionId, answer: { action: "decline" } };
		expect(
			(
				await f.request("workflow/native-surface/response", {
					...body,
					target: { ...target, round: target.round + 1 },
				})
			).status,
		).toBe(409);
		expect(broker.pendingInteractions).toHaveLength(1);
		const accepted = await f.request("workflow/native-surface/response", body);
		expect(accepted.ok).toBe(true);
		expect(await accepted.json()).toEqual({ accepted: true });
		expect(await waiting).toBe(false);
		expect(
			(await f.request("workflow/native-surface/response", { ...body, answer: { action: "accept" } })).status,
		).toBe(409);
		expect(f.session.sessionId).toBe(rootId);
		expect(f.session.messages).toEqual([]);
		expect(f.provider.requests).toEqual([]);
	}, 120_000);

	test("native binary transport rejects plain-text prompts without creating actors or changing workflow facts", async () => {
		await using f = await fixture();
		const selected = await f.create();
		const before = await f.view();
		const beforeRequests = f.provider.requests.length;
		const url = new URL(`ws?projectId=${selected.projectId}&irId=${selected.irId}`, f.base);
		url.protocol = "ws:";
		url.searchParams.set("clientId", f.clientId);
		const opened = Promise.withResolvers<void>();
		const ended = Promise.withResolvers<number>();
		const socket = new WebSocket(url, {
			headers: { Cookie: f.cookie, Origin: f.base.origin, "X-Dev-Client": f.clientId },
		});
		socket.addEventListener("open", () => opened.resolve());
		socket.addEventListener("error", () => opened.reject(new Error("Native binary transport failed to open")));
		socket.addEventListener("close", event => ended.resolve(event.code));
		await opened.promise;
		socket.send(JSON.stringify({ t: "prompt", text: "must not bypass native command admission" }));
		expect(await ended.promise).toBe(1008);
		const after = await f.view();
		expect(after.revision).toBe(before.revision);
		expect(after.sessions).toEqual(before.sessions);
		expect(after.running).toEqual(before.running);
		expect(f.provider.requests).toHaveLength(beforeRequests);
		expect(f.session.messages).toEqual([]);
	}, 120_000);

	test("application workflow observer survives page object rebindings without creating actors", async () => {
		await using f = await fixture();
		const selected = await f.create();
		const initial = Promise.withResolvers<void>();
		const changed = Promise.withResolvers<string>();
		const address = new URL("workflow/events?scope=application", f.base);
		address.protocol = "ws:";
		address.searchParams.set("clientId", f.clientId);
		const socket = new WebSocket(address, {
			headers: { Cookie: f.cookie, Origin: f.base.origin, "X-Dev-Client": f.clientId },
		});
		socket.addEventListener("message", event => {
			const frame = JSON.parse(String(event.data));
			if (frame.t === "workflow") initial.resolve();
			if (frame.t === "binding" && frame.binding?.irId && frame.binding.irId !== selected.irId)
				changed.resolve(frame.binding.irId);
		});
		socket.addEventListener("error", () => {
			initial.reject(new Error("Application workflow observer failed"));
			changed.reject(new Error("Application workflow observer failed"));
		});
		try {
			await initial.promise;
			const other = await f.create();
			expect(await changed.promise).toBe(other.irId!);
			expect(socket.readyState).toBe(WebSocket.OPEN);
			expect(f.provider.requests).toHaveLength(0);
		} finally {
			socket.close();
		}
	}, 120_000);

	test("event reconnect reads facts without actor creation; socket mutations close and rebinding discards old object delivery", async () => {
		await using f = await fixture();
		const selected = await f.create();
		const before = await f.view();
		const beforeRequests = f.provider.requests.length;
		async function connection() {
			const first = Promise.withResolvers<DevWorkflowView>();
			const ended = Promise.withResolvers<void>();
			const frames: object[] = [];
			const url = new URL(`workflow/events?projectId=${selected.projectId}&irId=${selected.irId}`, f.base);
			url.protocol = "ws:";
			url.searchParams.set("clientId", f.clientId);
			const socket = new WebSocket(url, {
				headers: { Cookie: f.cookie, Origin: f.base.origin, "X-Dev-Client": f.clientId },
			});
			socket.addEventListener("message", event => {
				const frame = JSON.parse(String(event.data));
				frames.push(frame);
				if (frame.t === "workflow" && frame.view) first.resolve(frame.view);
			});
			socket.addEventListener("error", () => first.reject(new Error("Workflow event socket failed")));
			socket.addEventListener("close", () => ended.resolve());
			return { socket, view: await first.promise, ended: ended.promise, frames };
		}
		const first = await connection();
		expect(first.view.revision).toBe(before.revision);
		expect(first.view.sessions).toEqual(before.sessions);
		expect(first.view.running).toEqual(before.running);
		first.socket.close();
		await first.ended;
		const second = await connection();
		expect(second.view.revision).toBe(first.view.revision);
		expect(second.view.sessions).toEqual(before.sessions);
		expect(second.view.running).toEqual(before.running);
		second.socket.send(JSON.stringify({ type: "stop", ...selected }));
		await second.ended;
		const afterRejected = await f.view();
		expect(afterRejected.revision).toBe(before.revision);
		expect(afterRejected.sessions).toEqual(before.sessions);
		expect(afterRejected.running).toEqual(before.running);
		const third = await connection();
		expect(third.view.revision).toBe(before.revision);
		expect(third.view.sessions).toEqual(before.sessions);
		expect(third.view.running).toEqual(before.running);
		const other = await f.create();
		expect(other.irId).not.toBe(selected.irId);
		const afterCreate = await f.view();
		expect(afterCreate.selected).toMatchObject({ projectId: other.projectId, irId: other.irId });
		await third.ended;
		const afterRebind = await f.view();
		expect(afterRebind.revision).toBe(afterCreate.revision);
		expect(afterRebind.sessions).toEqual(afterCreate.sessions);
		expect(afterRebind.running).toEqual(afterCreate.running);
		expect(f.provider.requests).toHaveLength(beforeRequests);
		expect(f.session.messages).toEqual([]);
	}, 120_000);
});
