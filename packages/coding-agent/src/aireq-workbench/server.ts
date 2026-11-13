import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { offlineFromEnv } from "../cli/args";
import { getWorkbenchAddresses } from "../utils/browser-network";
import type { OmpWebSocketData } from "../webgui/application";
import { registerAIReqApplication } from "../webgui/server";
import { getAIReqWorkbenchAsset, getAIReqWorkbenchAssetManifest, type AIReqWorkbenchAsset } from "./assets";
import type { AIReqWorkbenchHandle, AIReqWorkbenchHost } from "./host";
import type { AIReqObjectRef, AIReqWorkflowCommand } from "./workflow-types";
import { openAIReqNativeServices, type AIReqNativeServices } from "./workflow-services";
import type { WebGuiServiceContext } from "./native/rpc-contract";
import type { AIReqBrowserBinding } from "./workflow-host";
import type { AIReqNativeSurfaceTarget, AIReqNativePredictionAction } from "./native/native-surface-types";
import type { NativeWebGuiInteractionAnswer } from "./native/native-interactions";
import type { GuestFrame } from "@oh-my-pi/pi-wire";
import type { AIReqCollabTarget } from "./collab";

export interface BrowserConnection {
	readonly kind: "aireq";
	readonly application: AIReqWorkbenchApplication;
	browserId: string;
	requirementId: string | null;
	closed: boolean;
	mode?: "events" | "rpc" | "collab";
	binding?: AIReqBrowserBinding;
	context?: WebGuiServiceContext;
	rpc?: AIReqNativeServices;
	dispose?: () => Promise<void>;
}
export interface AIReqWorkbenchApplication {
	readonly basePath: string;
	readonly allowLan: boolean;
	fetch(request: Request, server: Bun.Server<OmpWebSocketData>): Response | undefined | Promise<Response | undefined>;
	readonly websocket: WebSocketHandler<BrowserConnection>;
	close(): Promise<void>;
}
export interface AIReqWorkbenchApplicationOptions {
	basePath?: string;
	asset?: (assetPath: string) => Promise<AIReqWorkbenchAsset | null>;
	offline?: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
function record(value: unknown): Record<string, unknown> {
	if (!object(value)) throw new TypeError("Expected JSON object");
	return value;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required`);
	return value;
}
function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`Invalid ${label}`);
	return Number(value);
}
function ref(value: Record<string, unknown>): AIReqObjectRef {
	return {
		projectId: text(value.projectId, "projectId"),
		irId: text(value.irId, "irId"),
		...(value.srId === undefined ? {} : { srId: text(value.srId, "srId") }),
	};
}
function selection(value: Record<string, unknown>) {
	return {
		projectId: text(value.projectId, "projectId"),
		...(value.irId === undefined ? {} : { irId: text(value.irId, "irId") }),
		...(value.srId === undefined ? {} : { srId: text(value.srId, "srId") }),
		...(value.sessionId === undefined
			? {}
			: { sessionId: text(value.sessionId, "sessionId"), round: integer(value.round, "round") }),
	};
}
function query(url: URL): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of url.searchParams) {
		if (key in result) throw new TypeError(`Duplicate query parameter: ${key}`);
		result[key] = value;
	}
	return result;
}
function surfaceTarget(value: Record<string, unknown>, fromQuery = false): AIReqNativeSurfaceTarget {
	const phase = text(value.phase, "phase");
	if (!["requirements", "solution", "planning", "executing", "pr"].includes(phase))
		throw new TypeError("Invalid native phase");
	return {
		...ref(value),
		sessionId: text(value.sessionId, "sessionId"),
		phase: phase as AIReqNativeSurfaceTarget["phase"],
		round: integer(fromQuery ? Number(text(value.round, "round")) : value.round, "round"),
		clientId: text(value.clientId, "clientId"),
	};
}
function collabTarget(value: unknown): AIReqCollabTarget {
	const input = record(value);
	return {
		peerId: text(input.peerId, "peerId"),
		roomId: text(input.roomId, "roomId"),
		sessionId: text(input.sessionId, "sessionId"),
		generation: integer(input.generation, "generation"),
	};
}
function guestFrame(value: unknown): GuestFrame {
	const input = record(value);
	const type = text(input.t, "frame.t");
	if (type === "abort") return { t: "abort" };
	if (type === "prompt") {
		if (typeof input.text !== "string") throw new TypeError("Prompt text must be a string");
		if (
			input.images !== undefined &&
			(!Array.isArray(input.images) ||
				input.images.some(
					image =>
						!object(image) ||
						image.type !== "image" ||
						typeof image.data !== "string" ||
						typeof image.mimeType !== "string",
				))
		)
			throw new TypeError("Invalid native images");
		return {
			t: "prompt",
			text: input.text,
			...(input.images === undefined
				? {}
				: { images: input.images as Extract<GuestFrame, { t: "prompt" }>["images"] }),
		};
	}
	if (type === "ui-response")
		return {
			t: "ui-response",
			reqId: integer(input.reqId, "reqId"),
			value: input.value as Extract<GuestFrame, { t: "ui-response" }>["value"],
		};
	if (type === "fetch-transcript")
		return {
			t: "fetch-transcript",
			reqId: integer(input.reqId, "reqId"),
			agentId: text(input.agentId, "agentId"),
			fromByte: integer(input.fromByte, "fromByte"),
		};
	if (type === "agent-cmd") {
		if (!["chat", "kill", "revive"].includes(String(input.cmd))) throw new TypeError("Invalid native agent command");
		if (input.text !== undefined && typeof input.text !== "string") throw new TypeError("Invalid native agent input");
		return {
			t: "agent-cmd",
			cmd: input.cmd as "chat" | "kill" | "revive",
			agentId: text(input.agentId, "agentId"),
			...(input.text === undefined ? {} : { text: input.text as string }),
		};
	}
	throw new TypeError("Unknown collaborative native frame");
}
const commandTypes = new Set([
	"registerProject",
	"createRelease",
	"createLocalDraft",
	"createBrowserDraft",
	"importPackage",
	"confirmRequirements",
	"markRequirementsPrSubmitted",
	"markRequirementsMerged",
	"startSr",
	"approveStage",
	"backStage",
	"markCodePrSubmitted",
	"markCodeMerged",
	"stop",
	"publishMaterials",
	"deleteRequirement",
]);
function command(value: unknown): AIReqWorkflowCommand {
	const input = record(value);
	text(input.operationId, "operationId");
	integer(input.expectedRevision, "expectedRevision");
	const type = text(input.type, "type");
	if (!commandTypes.has(type)) throw new TypeError("Unknown AIReq workflow command");
	for (const key of ["projectId", "irId", "srId"]) if (input[key] !== undefined) text(input[key], key);
	const payload: string[] = [];
	const requireText = (...keys: string[]) => {
		for (const key of keys) {
			text(input[key], key);
			payload.push(key);
		}
	};
	switch (type) {
		case "registerProject":
			requireText("root", "name", "registrationScope");
			if (
				input.registrationScope !== "target-root" ||
				input.expectedRevision !== 0 ||
				["projectId", "irId", "srId"].some(key => input[key] !== undefined)
			)
				throw new TypeError(
					"Project registration requires target-root scope, revision 0, and no selected object identity",
				);
			break;
		case "createRelease":
			requireText("title");
			break;
		case "createLocalDraft":
		case "createBrowserDraft":
			requireText("releaseId");
			break;
		case "importPackage":
			requireText("releaseId", "packageId");
			break;
		case "confirmRequirements":
			requireText("snapshotDigest");
			break;
		case "markRequirementsPrSubmitted":
		case "markCodePrSubmitted":
			requireText("url");
			break;
		case "approveStage":
			requireText("stage", "materialDigest");
			integer(input.round, "round");
			payload.push("round");
			if (!["solution", "planning", "executing", "pr"].includes(String(input.stage)))
				throw new TypeError("Unknown AIReq phase");
			break;
		case "backStage":
			requireText("stage");
			if (!["solution", "planning", "executing"].includes(String(input.stage)))
				throw new TypeError("Back target must be solution, planning or executing");
			break;
		case "deleteRequirement":
			if (input.version !== 1 || input.srId !== undefined)
				throw new TypeError("deleteRequirement requires version 1 and an IR-only target");
			requireText("projectId", "irId");
			payload.push("version");
			break;
		case "publishMaterials":
			requireText("scope", "message");
			payload.push("paths", "versions", "push");
			if (input.scope !== "requirements" && input.scope !== "development")
				throw new TypeError("Unknown publish scope");
			if (
				!Array.isArray(input.paths) ||
				!input.paths.length ||
				input.paths.some(item => typeof item !== "string" || !item)
			)
				throw new TypeError("Explicit publish paths are required");
			if (typeof input.push !== "boolean") throw new TypeError("push must be a boolean");
			if (
				input.versions !== undefined &&
				(!Array.isArray(input.versions) ||
					input.versions.some(
						item =>
							!object(item) ||
							typeof item.path !== "string" ||
							typeof item.sha256 !== "string" ||
							!Number.isSafeInteger(item.size) ||
							Number(item.size) < -1 ||
							Object.keys(item).some(key => !["path", "sha256", "size"].includes(key)),
					))
			)
				throw new TypeError("Invalid publish byte versions");
			break;
	}
	const allowed = new Set(["type", "operationId", "expectedRevision", "projectId", "irId", "srId", ...payload]);
	if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError("Unknown workflow command field");
	return input as unknown as AIReqWorkflowCommand;
}

/** Capability-bound transport on the existing OMP process listener, never an internal proxy. */
export async function createAIReqWorkbenchApplication(
	host: AIReqWorkbenchHost,
	options: AIReqWorkbenchApplicationOptions = {},
): Promise<AIReqWorkbenchApplication> {
	const asset = options.asset ?? getAIReqWorkbenchAsset;
	const launchCommonDir = await fs.realpath(vcs.requireGit(host.cwd).info().commonDir);
	const launchProject = (await host.workflow.store.listProjects()).find(
		project => project.commonDir === launchCommonDir,
	);
	if (!launchProject) throw new Error("Launch project is not registered in the AIReq workflow");
	const allowLan = options.offline ?? offlineFromEnv();
	const allowedAddresses = getWorkbenchAddresses(allowLan);
	const capability = randomBytes(32).toString("hex");
	const prefix = `${(options.basePath ?? "").replace(/\/$/, "")}/${capability}/`;
	const cookieName = `omp_aireq_${capability.slice(0, 12)}`;
	const browsers = new Set<string>();
	const sockets = new Set<ServerWebSocket<BrowserConnection>>();
	let closing: Promise<void> | undefined;
	let closed = false;
	const disconnecting = new Map<ServerWebSocket<BrowserConnection>, Promise<void>>();
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
	const browser = (request: Request) => {
		const value = request.headers
			.get("cookie")
			?.split(";")
			.map(item => item.trim())
			.find(item => item.startsWith(`${cookieName}=`))
			?.slice(cookieName.length + 1);
		return value && browsers.has(value) ? value : undefined;
	};
	const disconnect = (socket: ServerWebSocket<BrowserConnection>): Promise<void> => {
		const pending = disconnecting.get(socket);
		if (pending) return pending;
		if (socket.data.closed && !sockets.has(socket)) return Promise.resolve();
		socket.data.closed = true;
		const task = (async () => {
			await socket.data.rpc?.close();
			await socket.data.dispose?.();
			if (socket.data.context) host.workflow.closeNativeContext(socket.data.context);
			sockets.delete(socket);
		})();
		disconnecting.set(socket, task);
		void task.then(
			() => disconnecting.delete(socket),
			() => disconnecting.delete(socket),
		);
		return task;
	};
	const application: AIReqWorkbenchApplication = {
		basePath: prefix,
		allowLan,
		async fetch(request, server) {
			const url = new URL(request.url);
			if (!url.pathname.startsWith(prefix)) return undefined;
			if (closed) return json({ error: "AIReq application is closed" }, 503);
			if (
				!allowedAddresses.includes(url.hostname) ||
				request.headers.get("host") !== `${url.hostname}:${server.port}`
			)
				return json({ error: "Unrecognized AIReq Host" }, 403);
			const origin = request.headers.get("origin");
			if (origin && origin !== url.origin) return json({ error: "Cross-origin AIReq request rejected" }, 403);
			if (request.headers.get("sec-fetch-site") === "cross-site")
				return json({ error: "Cross-site AIReq request rejected" }, 403);
			let route: string;
			try {
				route = decodeURIComponent(url.pathname.slice(prefix.length));
			} catch {
				return json({ error: "Invalid path encoding" }, 400);
			}
			if (
				route.includes("\\") ||
				route.includes("\0") ||
				route.split("/").some(part => part === "." || part === "..")
			)
				return json({ error: "Invalid AIReq path" }, 400);
			let browserId = browser(request);
			if (route === "api/browser" && request.method === "GET") {
				if (!browserId) {
					browserId = randomBytes(24).toString("hex");
					browsers.add(browserId);
				}
				const response = json({ browserId, launchProjectId: launchProject.id });
				response.headers.set(
					"set-cookie",
					`${cookieName}=${browserId}; Path=${prefix}; HttpOnly; SameSite=Strict${url.protocol === "https:" ? "; Secure" : ""}`,
				);
				return response;
			}
			const dynamic =
				route.startsWith("workflow") ||
				route.startsWith("api/") ||
				route === "server-info" ||
				route === "ws" ||
				route === "session-info" ||
				route === "projects" ||
				route === "collab" ||
				route.startsWith("collab/");
			if (!dynamic) {
				if (request.method !== "GET" && request.method !== "HEAD")
					return json({ error: "Method not allowed" }, 405);
				const file = await asset(`/${route}`);
				return file
					? new Response(request.method === "HEAD" ? null : file.bytes, {
							headers: {
								"content-type": file.contentType,
								"cache-control": "no-cache",
								"x-content-type-options": "nosniff",
							},
						})
					: json({ error: "Asset not found" }, 404);
			}
			if (!browserId) return json({ error: "Initialize browser through api/browser" }, 401);
			try {
				const params = query(url);
				const suppliedClient = request.headers.get("x-aireq-client");
				if (suppliedClient && params.clientId !== undefined && params.clientId !== suppliedClient)
					throw new TypeError("AIReq page identity mismatch");
				const client = suppliedClient ?? params.clientId ?? "default";
				if (typeof client !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(client))
					throw new TypeError("Invalid AIReq page identity");
				browserId = `${browserId}:${client}`;
				if (request.method === "GET") {
					if (route === "workflow")
						return json(
							await host.workflow.view(
								typeof params.projectId === "string" ? params.projectId : undefined,
								params.irId ? ref(params) : undefined,
							),
						);
					if (route === "workflow/material")
						return json(await host.workflow.readMaterial(ref(params), text(params.path, "path")));
					if (route === "collab") return json(host.workflow.collabView(browserId));
					if (route === "workflow/native-surface")
						return json(await host.workflow.surfaceSnapshot(browserId, surfaceTarget(params, true)));
					if (route === "workflow/package") {
						const bytes = await host.workflow.exportPackage(
							text(params.projectId, "projectId"),
							text(params.irId, "irId"),
						);
						return new Response(bytes, {
							headers: {
								"content-type": "application/zip",
								"content-disposition": "attachment; filename=requirements.zip",
								"cache-control": "no-store",
								"x-content-type-options": "nosniff",
							},
						});
					}
					if (route === "api/assets-manifest") return json(await getAIReqWorkbenchAssetManifest());
					if (route === "server-info" || route === "session-info") {
						const metadata = await host.workflow.workspace(
							browserId,
							typeof params.projectId === "string" ? params.projectId : undefined,
						);
						return route === "server-info"
							? json({
									workspaces: [{ path: metadata.cwd, workspaceIdentity: metadata.workspaceIdentity }],
									businessAvailable: true,
									binding: metadata.binding,
									session: metadata.session,
								})
							: json({
									bound: !!metadata.session,
									sessionId: metadata.session?.sessionId,
									cwd: metadata.cwd,
									binding: metadata.binding,
								});
					}
					if (route === "projects")
						return json({
							projects: (await host.workflow.store.listProjects()).map(project => ({
								projectId: project.id,
								root: project.root,
								mode: "aireq",
								phase: "active",
							})),
						});
					if (route === "workflow/events" || route === "ws" || route === "collab/events") {
						if (!origin) return json({ error: "WebSocket Origin is required" }, 403);
						// Application observers survive object/RPC rebindings on this page.
						const selected =
							route === "workflow/events" && params.scope === "application"
								? undefined
								: host.workflow.binding(browserId);
						if (route !== "collab/events" && params.irId) {
							const requested = ref(params);
							host.workflow.assertBrowser(browserId, requested);
						}
						if (
							route !== "collab/events" &&
							params.sessionId !== undefined &&
							(params.sessionId !== selected?.sessionId ||
								integer(Number(params.round), "round") !== selected?.round)
						)
							throw new Error("Native session/round binding changed");
						const context =
							route === "ws"
								? await host.workflow.nativeContext(
										browserId,
										typeof params.projectId === "string" ? params.projectId : undefined,
									)
								: undefined;
						if (
							server.upgrade(request, {
								data: {
									kind: "aireq",
									application,
									browserId,
									requirementId: null,
									closed: false,
									mode: route === "ws" ? "rpc" : route === "collab/events" ? "collab" : "events",
									binding: route === "collab/events" ? undefined : selected,
									context,
								},
							})
						)
							return;
						if (context) host.workflow.closeNativeContext(context);
						return json({ error: "WebSocket upgrade required" }, 426);
					}
				}
				if (request.method === "POST") {
					if (host.stopping) throw new Error("AIReq host is exiting");
					if (route === "workflow/packages") {
						if (!request.headers.get("content-type")?.startsWith("application/zip"))
							return json({ error: "Expected application/zip" }, 415);
						const declared = Number(request.headers.get("content-length") ?? 0);
						if (declared > 128 * 1024 * 1024) return json({ error: "Package too large" }, 413);
						const bytes = new Uint8Array(await request.arrayBuffer());
						if (bytes.length > 128 * 1024 * 1024) return json({ error: "Package too large" }, 413);
						return json(await host.workflow.upload(browserId, text(params.projectId, "projectId"), bytes));
					}
					if (
						![
							"workflow/command",
							"workflow/bind",
							"workflow/input",
							"workflow/native-surface/editor",
							"workflow/native-surface/response",
							"workflow/native-surface/prediction",
							"collab/join",
							"collab/frame",
							"collab/leave",
						].includes(route)
					)
						return json({ error: "Route not found" }, 404);
					if (!request.headers.get("content-type")?.startsWith("application/json"))
						return json({ error: "Expected application/json" }, 415);
					const input = record(await request.json());
					if (route === "collab/join")
						return json(
							await host.workflow.collab.join(
								{
									browserId,
									usernameOrLink: text(input.usernameOrLink, "usernameOrLink"),
									name: input.name === undefined ? "AIReq browser" : text(input.name, "name"),
								},
								request.signal,
							),
						);
					if (route === "collab/frame")
						return json(
							await host.workflow.collab.sendFrame(
								browserId,
								collabTarget(input.target),
								guestFrame(input.frame),
							),
						);
					if (route === "collab/leave") {
						await host.workflow.collab.leave(browserId, collabTarget(input.target));
						return json({ left: true });
					}
					if (route.startsWith("workflow/native-surface/")) {
						const target = surfaceTarget(record(input.target));
						if (route === "workflow/native-surface/editor") {
							if (typeof input.text !== "string") throw new TypeError("Editor text must be a string");
							return json(await host.workflow.surfaceEditor(browserId, target, input.text));
						}
						if (route === "workflow/native-surface/response")
							return json(
								await host.workflow.surfaceResponse(
									browserId,
									target,
									text(input.requestId, "requestId"),
									record(input.answer) as NativeWebGuiInteractionAnswer,
								),
							);
						return json(
							await host.workflow.surfacePrediction(
								browserId,
								target,
								record(input.action) as unknown as AIReqNativePredictionAction,
							),
						);
					}
					if (route === "workflow/command") return json(await host.workflow.command(browserId, command(input)));
					if (route === "workflow/bind") return json(await host.workflow.bind(browserId, selection(input)));
					if (route === "workflow/input")
						return json(
							await host.workflow.submit(browserId, {
								...ref(input),
								operationId: text(input.operationId, "operationId"),
								expectedRevision: integer(input.expectedRevision, "expectedRevision"),
								text: text(input.text, "text"),
								...(input.sessionId === undefined
									? {}
									: { sessionId: text(input.sessionId, "sessionId"), round: integer(input.round, "round") }),
							}),
						);
				}
				return json({ error: "Route not found" }, 404);
			} catch (error) {
				return json(
					{ error: error instanceof Error ? error.message : String(error), category: "aireq-workflow" },
					error instanceof TypeError || error instanceof SyntaxError ? 400 : 409,
				);
			}
		},
		websocket: {
			async open(socket) {
				sockets.add(socket);
				try {
					if (socket.data.mode === "collab") {
						const dispose = host.workflow.collab.subscribe(socket.data.browserId, event => {
							if (!socket.data.closed) socket.send(JSON.stringify(event));
						});
						const snapshot = host.workflow.collab.read(socket.data.browserId);
						socket.send(JSON.stringify({ type: "snapshot", snapshot, target: snapshot?.participant ?? null }));
						socket.data.dispose = async () => {
							dispose();
						};
						return;
					}
					if (socket.data.mode === "rpc") {
						if (!socket.data.context) throw new Error("Missing AIReq native context");
						socket.data.rpc = openAIReqNativeServices(socket, socket.data.context);
						return;
					}
					const send = (event: object) => {
						if (!socket.data.closed) socket.send(JSON.stringify(event));
					};
					const binding = socket.data.binding;
					const dispose = host.workflow.observe(event => {
						const current = host.workflow.binding(socket.data.browserId);
						if (
							binding &&
							(current?.epoch !== binding.epoch ||
								current.projectId !== binding.projectId ||
								current.irId !== binding.irId ||
								current.srId !== binding.srId)
						) {
							socket.close(1008, "AIReq object selection changed");
							return;
						}
						const record = event as {
							projectId?: string;
							binding?: AIReqObjectRef & { sessionId?: string; round?: number };
							browserId?: string;
						};
						if (record.browserId && record.browserId !== socket.data.browserId) return;
						if (binding && record.projectId && record.projectId !== binding.projectId) return;
						if (
							binding &&
							record.binding &&
							(record.binding.projectId !== binding.projectId ||
								record.binding.irId !== binding.irId ||
								record.binding.srId !== binding.srId)
						)
							return;
						if (
							binding?.sessionId &&
							record.binding?.sessionId &&
							(binding.sessionId !== record.binding.sessionId || binding.round !== record.binding.round)
						)
							return;
						send(event);
					});
					socket.data.dispose = async () => {
						dispose();
					};
					send({
						t: "workflow",
						view: await host.workflow.view(
							binding?.projectId,
							binding?.irId
								? { projectId: binding.projectId, irId: binding.irId, srId: binding.srId }
								: undefined,
						),
					});
				} catch (error) {
					socket.send(JSON.stringify({ t: "error", error: String(error) }));
					socket.close(1008, "Invalid AIReq binding");
				}
			},
			message(socket, value) {
				try {
					if (socket.data.mode !== "rpc") throw new Error("Use explicit HTTP workflow commands");
					socket.data.rpc?.message(value);
				} catch (error) {
					socket.send(JSON.stringify({ t: "error", error: String(error) }));
					socket.close(1008, "Invalid AIReq native frame");
				}
			},
			drain(socket) {
				socket.data.rpc?.drained();
			},
			close(socket) {
				void disconnect(socket).catch(() => {});
			},
		},
		close() {
			if (!closing) {
				closed = true;
				const task = (async () => {
					const pending = [];
					for (const socket of sockets) {
						pending.push(disconnect(socket));
						socket.close(1001, "AIReq mode exited");
					}
					await Promise.all(pending);
				})();
				closing = task;
				void task.catch(() => {
					if (closing === task) closing = undefined;
				});
			}
			return closing;
		},
	};
	return application;
}
export async function startAIReqWorkbenchServer(
	host: AIReqWorkbenchHost,
	options: AIReqWorkbenchApplicationOptions = {},
): Promise<AIReqWorkbenchHandle> {
	const application = await createAIReqWorkbenchApplication(host, options);
	try {
		return await registerAIReqApplication(application);
	} catch (error) {
		await application.close();
		throw error;
	}
}
