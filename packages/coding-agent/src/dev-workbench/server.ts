import { randomBytes } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { GuestFrame } from "@oh-my-pi/pi-wire";
import { wordCompletionQuery } from "@oh-my-pi/pi-tui/prompt/word-completion";
import { cfgSpellingAutocomplete } from "../modes/settings";
import { textPredictionBackend } from "../predict/client";
import { offlineFromEnv } from "../cli/args";
import type {
	DevActionIntent,
	DevGitTarget,
	DevInputTarget,
	DevNativeUiResponse,
	DevSessionTarget,
	DevStage,
	SpecDocument,
} from "../spec-driven/types";
import { getDevWorkbenchAsset, getDevWorkbenchAssetManifest, type DevWorkbenchAsset } from "./assets";
import type { DevWorkbenchHandle, DevWorkbenchHost } from "./host";

interface BrowserConnection {
	browserId: string;
	requirementId: string | null;
	dispose?: () => Promise<void>;
	closed: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
function bodyObject(value: unknown): Record<string, unknown> {
	if (!object(value)) throw new Error("A JSON object is required");
	return value;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	return value;
}
function nonnegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${label}`);
	return Number(value);
}
function guestFrame(value: unknown): GuestFrame {
	const frame = bodyObject(value);
	switch (frame.t) {
		case "abort":
			return { t: "abort" };
		case "ui-response":
			if (frame.value !== undefined && typeof frame.value !== "string")
				throw new Error("Invalid native wire UI response");
			return { t: "ui-response", reqId: nonnegativeInteger(frame.reqId, "native reqId"), value: frame.value };
		case "agent-cmd": {
			const cmd = frame.cmd;
			if (cmd !== "chat" && cmd !== "kill" && cmd !== "revive") throw new Error("Invalid native agent operation");
			if (frame.text !== undefined && typeof frame.text !== "string")
				throw new Error("Invalid native agent message");
			return { t: "agent-cmd", cmd, agentId: text(frame.agentId, "agentId"), text: frame.text };
		}
		case "fetch-transcript":
			return {
				t: "fetch-transcript",
				reqId: nonnegativeInteger(frame.reqId, "transcript reqId"),
				agentId: text(frame.agentId, "agentId"),
				fromByte: nonnegativeInteger(frame.fromByte, "transcript offset"),
			};
		default:
			throw new Error("Native prompts require the receipt route; this native frame is unavailable");
	}
}
function target(value: unknown): DevSessionTarget {
	const input = bodyObject(value);
	if (input.requirementId !== null && typeof input.requirementId !== "string")
		throw new Error("Invalid native requirement identity");
	if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0)
		throw new Error("Invalid native generation");
	return {
		requirementId: input.requirementId,
		sessionId: text(input.sessionId, "sessionId"),
		generation: Number(input.generation),
	};
}
function inputTarget(value: unknown): DevInputTarget {
	const input = bodyObject(value);
	if (input.kind !== "collab") return target(input);
	if (!Number.isSafeInteger(input.generation) || Number(input.generation) < 0)
		throw new Error("Invalid guest generation");
	return {
		kind: "collab",
		peerId: text(input.peerId, "peerId"),
		roomId: text(input.roomId, "roomId"),
		sessionId: text(input.sessionId, "sessionId"),
		generation: Number(input.generation),
	};
}
function queryTarget(url: URL): DevInputTarget {
	return inputTarget({
		kind: url.searchParams.get("kind"),
		peerId: url.searchParams.get("peerId"),
		roomId: url.searchParams.get("roomId"),
		requirementId: url.searchParams.get("requirementId"),
		sessionId: url.searchParams.get("sessionId"),
		generation: Number(url.searchParams.get("generation")),
	});
}
function images(value: unknown): ImageContent[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw new Error("Image attachments must be an array");
	return value.map(item => {
		const image = bodyObject(item);
		if (image.type !== "image") throw new Error("Invalid native image attachment");
		return { type: "image", data: text(image.data, "image data"), mimeType: text(image.mimeType, "image MIME type") };
	});
}
function stage(value: unknown): DevStage {
	if (
		value !== "business" &&
		value !== "requirements" &&
		value !== "solution" &&
		value !== "planning" &&
		value !== "executing" &&
		value !== "st" &&
		value !== "pr" &&
		value !== "testing"
	)
		throw new Error("Invalid expected stage");
	return value;
}
function intent(value: unknown): DevActionIntent {
	const input = bodyObject(value);
	if ("previewId" in input || "operationId" in input || "binding" in input)
		throw new Error("Action identity is allocated by the host");
	switch (input.kind) {
		case "next":
			return {
				kind: "next",
				...(input.candidateId === undefined ? {} : { candidateId: text(input.candidateId, "candidateId") }),
			};
		case "back":
			return { kind: "back" };
		case "sync-archive":
			return { kind: "sync-archive" };
		case "cancel":
			return { kind: "cancel" };
		case "commit":
			return { kind: "commit" };
		case "mark": {
			const mark = input.mark;
			if (mark !== "st-complete" && mark !== "pr-submitted" && mark !== "pr-merged" && mark !== "tested")
				throw new Error("Invalid human mark");
			return { kind: "mark", mark };
		}
		case "set-test-state": {
			const state = input.state;
			if (state !== "in-progress" && state !== "failed" && state !== "retest-pending")
				throw new Error("Invalid test state");
			return { kind: "set-test-state", state };
		}
		case "link-fix":
			return { kind: "link-fix", fixRequirementId: text(input.fixRequirementId, "fixRequirementId") };
		default:
			throw new Error("Unknown workbench action");
	}
}
function gitTarget(value: unknown): DevGitTarget | null {
	if (value === null || value === undefined) return null;
	const input = bodyObject(value);
	if (input.observedTip !== null && typeof input.observedTip !== "string")
		throw new Error("Invalid observed remote tip");
	return {
		localSourceRef: text(input.localSourceRef, "localSourceRef"),
		sourceRepository: text(input.sourceRepository, "sourceRepository"),
		sourceRef: text(input.sourceRef, "sourceRef"),
		baseRepository: text(input.baseRepository, "baseRepository"),
		baseRef: text(input.baseRef, "baseRef"),
		remote: text(input.remote, "remote"),
		remoteUrl: text(input.remoteUrl, "remoteUrl"),
		targetRef: text(input.targetRef, "targetRef"),
		observedTip: input.observedTip,
	};
}
function documentResponse(document: SpecDocument): Response {
	const name = path.basename(document.path).replace(/[^\p{L}\p{N}._-]/gu, "_");
	return new Response(document.content, {
		headers: {
			"content-type": name.endsWith(".json") ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
			"content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			"x-content-type-options": "nosniff",
			"cache-control": "no-store",
			etag: JSON.stringify(document.version),
		},
	});
}
export function getWorkbenchAddresses(allowLan: boolean): string[] {
	if (!allowLan) return ["127.0.0.1"];
	const discovered = Object.values(os.networkInterfaces())
		.flatMap(entries => entries ?? [])
		.filter(entry => entry.family === "IPv4" && !entry.internal && entry.address !== "0.0.0.0")
		.map(entry => entry.address);
	return [...new Set([...discovered, "127.0.0.1"])];
}

/** No browser subscription owns a task. Only close() stops the listening service. */
export async function startDevWorkbenchServer(
	host: DevWorkbenchHost,
	options: {
		asset?: (assetPath: string) => Promise<DevWorkbenchAsset | null>;
		offline?: boolean;
	} = {},
): Promise<DevWorkbenchHandle> {
	const asset = options.asset ?? getDevWorkbenchAsset;
	// Preparation failures must happen before publishing a listening URL.
	if (!(await asset("/"))) throw new Error("Workbench production HTML is unavailable");
	const offline = options.offline ?? offlineFromEnv();
	const capability = randomBytes(32).toString("hex");
	const prefix = `/${capability}/`;
	const cookieName = `omp_dev_${capability.slice(0, 12)}`;
	const browsers = new Set<string>();
	const connections = new Set<ServerWebSocket<BrowserConnection>>();
	const closing = new Set<Promise<void>>();
	const allowedAddresses = getWorkbenchAddresses(offline);
	const cookies = (request: Request): string | undefined => {
		const cookie = request.headers
			.get("cookie")
			?.split(";")
			.map(item => item.trim())
			.find(item => item.startsWith(`${cookieName}=`));
		const id = cookie?.slice(cookieName.length + 1);
		return id && browsers.has(id) ? id : undefined;
	};
	const json = (value: unknown, status = 200) =>
		Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
	const disconnect = (socket: ServerWebSocket<BrowserConnection>) => {
		if (socket.data.closed) return;
		socket.data.closed = true;
		connections.delete(socket);
		const task = socket.data.dispose?.() ?? host.guests.leaveDevCollab(socket.data.browserId);
		closing.add(task);
		void task.catch(() => {}).finally(() => closing.delete(task));
	};
	const server = Bun.serve<BrowserConnection>({
		hostname: offline ? "0.0.0.0" : "127.0.0.1",
		port: 0,
		maxRequestBodySize: 24 * 1024 * 1024,
		async fetch(request, server) {
			const url = new URL(request.url);
			const expectedHost = `${url.hostname}:${server.port}`;
			if (!allowedAddresses.includes(url.hostname) || request.headers.get("host") !== expectedHost)
				return json({ error: "Unrecognized workbench Host" }, 403);
			const origin = request.headers.get("origin");
			if (origin && origin !== url.origin)
				return json({ error: "Cross-origin workbench requests are not allowed" }, 403);
			if (request.headers.get("sec-fetch-site") === "cross-site")
				return json({ error: "Cross-site workbench requests are not allowed" }, 403);
			if (!url.pathname.startsWith(prefix)) return json({ error: "Workbench capability is missing" }, 404);
			let route: string;
			try {
				route = decodeURIComponent(url.pathname.slice(prefix.length - 1));
			} catch {
				return json({ error: "Invalid path encoding" }, 400);
			}
			if (
				route.includes("\\") ||
				route.includes("\0") ||
				route.split("/").some(part => part === "." || part === "..")
			)
				return json({ error: "Invalid workbench path" }, 400);
			let browserId = cookies(request);
			if (route === "/api/browser" && request.method === "GET") {
				if (!browserId) {
					browserId = randomBytes(24).toString("hex");
					browsers.add(browserId);
				}
				const response = json({ browserId });
				response.headers.set("set-cookie", `${cookieName}=${browserId}; Path=${prefix}; HttpOnly; SameSite=Strict`);
				return response;
			}
			if (!route.startsWith("/api/")) {
				if (request.method !== "GET" && request.method !== "HEAD")
					return json({ error: "Method not allowed" }, 405);
				const file = await asset(route);
				return file
					? new Response(request.method === "HEAD" ? null : file.bytes, {
							headers: {
								"content-type": file.contentType,
								"x-content-type-options": "nosniff",
								"cache-control": "no-cache",
							},
						})
					: json({ error: "Asset not found" }, 404);
			}
			if (!browserId) return json({ error: "Initialize this browser with /api/browser" }, 401);
			if (route === "/api/events" && request.method === "GET") {
				if (!origin) return json({ error: "WebSocket Origin is required" }, 403);
				const requirementId = url.searchParams.get("requirementId") || null;
				if (requirementId) await host.controller.getRequirement(requirementId);
				if (server.upgrade(request, { data: { browserId, requirementId, closed: false } })) return;
				return json({ error: "WebSocket upgrade failed" }, 400);
			}
			try {
				if (request.method === "GET") {
					if (route === "/api/requirements") return json(await host.controller.listRequirements());
					if (route === "/api/team-config") return json(await host.controller.getTeamConfiguration());
					if (route === "/api/local-business/material") {
						const document = await host.controller.readLocalBusiness();
						return document
							? documentResponse(document)
							: json({ error: "No local business Markdown has been generated" }, 404);
					}
					if (route === "/api/native-ui") return json(host.nativeUi.pending());
					if (route === "/api/assets-manifest") return json(await getDevWorkbenchAssetManifest());
					if (route === "/api/native-commands") return json(host.getNativeCommands(queryTarget(url), browserId));
					if (route === "/api/native-snapshot")
						return json(await host.readNativeSnapshot(browserId, queryTarget(url)));
					let match = /^\/api\/requirements\/([^/]+)$/.exec(route);
					if (match) return json(await host.controller.getRequirement(match[1]));
					match = /^\/api\/git-targets\/([^/]+)$/.exec(route);
					if (match) return json(await host.controller.discoverDevGitTargets(match[1]));
					match = /^\/api\/operations\/([^/]+)$/.exec(route);
					if (match) return json(await host.controller.readDevAction(match[1]));
					match = /^\/api\/inputs\/([^/]+)$/.exec(route);
					if (match) return json(host.inspectDevInput(browserId, match[1]));
					match = /^\/api\/materials\/([^/]+)$/.exec(route);
					if (match) return json(await host.controller.listMaterials(match[1]));
					// Delta identities include their native relative spec name; reads still resolve an exact authorized ID.
					match = /^\/api\/materials\/([^/]+)\/(.+)$/.exec(route);
					if (match) return documentResponse(await host.controller.readMaterial(match[1], match[2]));
				}
				if (request.method !== "POST") return json({ error: "Route not found" }, 404);
				if (route !== "/api/native-frame" && route !== "/api/collab/leave") host.assertWritable(browserId);
				const business = /^\/api\/business\/([^/]+)$/.exec(route);
				if (business) {
					if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
						const form = await request.formData();
						const file = form.get("file");
						if (!(file instanceof File)) throw new Error("Choose a Markdown file");
						const replaceVersion = form.has("replaceVersion")
							? text(form.get("replaceVersion"), "replaceVersion")
							: undefined;
						return json(
							await host.controller.importBusiness(
								business[1],
								{ kind: "upload", name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
								replaceVersion,
							),
						);
					}
					const input = bodyObject(await request.json());
					return json(
						await host.controller.importBusiness(
							business[1],
							{ kind: "host-path", path: text(input.path, "host path") },
							input.replaceVersion === undefined ? undefined : text(input.replaceVersion, "replaceVersion"),
						),
					);
				}
				const input = bodyObject(await request.json());
				if (route === "/api/composer-prediction") {
					if (input.event !== undefined && input.event !== "shown" && input.event !== "accepted")
						throw new Error("Invalid composer prediction feedback");
					const rank = input.rank === undefined ? undefined : nonnegativeInteger(input.rank, "prediction rank");
					return json(host.composerPrediction(browserId, inputTarget(input.target), input.event, rank));
				}
				if (route === "/api/text-prediction") {
					if (typeof input.text !== "string") throw new Error("Prediction text must be a string");
					const cursor = nonnegativeInteger(input.cursor, "prediction cursor");
					if (cursor > input.text.length) throw new Error("Prediction cursor is outside the text");
					const method = cfgSpellingAutocomplete.get(host.settings);
					if (method === "off") return json({ suffix: null });
					const head = input.text.slice(0, cursor).split("\n");
					const lines = input.text.split("\n");
					const query = wordCompletionQuery(lines, head.length - 1, head[head.length - 1].length);
					if (!query) return json({ suffix: null });
					const backend = textPredictionBackend(method);
					if (input.accepted !== undefined) {
						if (typeof input.accepted !== "boolean" || typeof input.suffix !== "string")
							throw new Error("Invalid prediction feedback");
						backend.feedback(query.before, query.prefix, input.suffix, input.accepted);
						return json({ suffix: null });
					}
					return json({ suffix: await backend.complete(query.before, query.prefix) });
				}
				if (route === "/api/requirements") {
					if (input.source !== "conversation" && input.source !== "import")
						throw new Error("Invalid requirement source");
					const relatedRequirementIds = input.relatedRequirementIds;
					if (
						relatedRequirementIds !== undefined &&
						(!Array.isArray(relatedRequirementIds) || !relatedRequirementIds.every(id => typeof id === "string"))
					)
						throw new Error("Invalid related requirements");
					return json(
						await host.controller.createRequirement({
							source: input.source,
							request: typeof input.request === "string" ? input.request : undefined,
							relatedRequirementIds,
						}),
					);
				}
				if (route === "/api/action-preview" || route === "/api/git-preview" || route === "/api/cancel-preview") {
					const action = intent(input.intent);
					if (route === "/api/cancel-preview" && action.kind !== "cancel")
						throw new Error("Cancellation preview requires cancel intent");
					return json(
						await host.prepareDevAction(browserId, {
							requirementId: text(input.requirementId, "requirementId"),
							expectedRecordVersion: text(input.expectedRecordVersion, "expectedRecordVersion"),
							expectedStage: stage(input.expectedStage),
							intent: action,
							gitTarget: gitTarget(input.gitTarget),
						}),
					);
				}
				if (route === "/api/actions")
					return json(
						await host.confirmDevAction(browserId, {
							operationId: text(input.operationId, "operationId"),
							confirmationToken: text(input.confirmationToken, "confirmationToken"),
							userReply: text(input.userReply, "userReply"),
						}),
					);
				if (route === "/api/local-business") {
					const result = await host.controller.startLocalBusiness(text(input.request, "request"));
					const session = host.controller.nativeSession();
					if (!session) throw new Error("Native business session was not created");
					return json({ ...result, target: host.targetForSession(session) });
				}
				if (route === "/api/team-config") {
					if (typeof input.useTeam !== "boolean") throw new Error("useTeam must be boolean");
					return json(
						await host.controller.saveTeamConfiguration({
							requirementId: typeof input.requirementId === "string" ? input.requirementId : null,
							expectedRecordVersion:
								typeof input.expectedRecordVersion === "string" ? input.expectedRecordVersion : null,
							useTeam: input.useTeam,
						}),
					);
				}
				if (route === "/api/input-preview") {
					const sessionTarget = input.target
						? inputTarget(input.target)
						: input.sessionId
							? target(input)
							: await host.controller.prepareSession(text(input.requirementId, "requirementId"));
					return json(host.prepareDevInput(browserId, sessionTarget));
				}
				if (route === "/api/input") {
					return json(
						await host.submitDevInput(browserId, {
							requestId: text(input.requestId, "requestId"),
							text: typeof input.text === "string" ? input.text : "",
							images: images(input.images),
						}),
					);
				}
				if (route === "/api/native-command") {
					if (!Array.isArray(input.args) || !input.args.every(arg => typeof arg === "string"))
						throw new Error("Command args must be strings");
					return json(
						await host.runDevNativeCommand(browserId, {
							target: inputTarget(input.target),
							command: text(input.command, "command"),
							args: input.args,
						}),
					);
				}
				if (route === "/api/native-editor") {
					if (typeof input.text !== "string") throw new Error("Native editor text must be a string");
					return json(host.updateNativeEditor(browserId, inputTarget(input.target), input.text));
				}
				if (route === "/api/native-frame") {
					return json(await host.sendNativeFrame(browserId, inputTarget(input.target), guestFrame(input.frame)));
				}
				if (route === "/api/native-ui-response") {
					const response: DevNativeUiResponse = {
						requestId: text(input.requestId, "requestId"),
						requirementId: typeof input.requirementId === "string" ? input.requirementId : "",
						sessionId: text(input.sessionId, "sessionId"),
						generation: Number(input.generation),
						value: input.value as DevNativeUiResponse["value"],
					};
					return json(await host.respondNativeUi(response));
				}
				if (route === "/api/collab/join")
					return json(
						await host.joinDevCollab(
							{
								browserId,
								usernameOrLink: text(input.usernameOrLink, "usernameOrLink"),
								name: text(input.name, "name"),
							},
							new AbortController().signal,
						),
					);
				if (route === "/api/collab/leave") {
					await host.guests.leaveDevCollab(browserId);
					return json({ left: true });
				}
				return json({ error: "Route not found" }, 404);
			} catch (error) {
				return json(
					{ error: error instanceof Error ? error.message : String(error), category: "workbench-operation" },
					409,
				);
			}
		},
		websocket: {
			async open(socket) {
				connections.add(socket);
				const send = (frame: object) => {
					if (!socket.data.closed) socket.send(JSON.stringify(frame));
				};
				const disposeBrowser = host.observeBrowser(socket.data.browserId, send);
				const disposeBusiness = host.controller.observe(snapshot => send({ t: "requirement", snapshot }));
				try {
					send({ t: "requirements", requirements: await host.controller.listRequirements() });
					const disposeNative = await host.subscribeNative(socket.data.browserId, socket.data.requirementId, send);
					socket.data.dispose = async () => {
						disposeBrowser();
						disposeBusiness();
						await disposeNative();
					};
					if (socket.data.closed) await socket.data.dispose();
					else {
						for (const state of host.nativeUi.snapshot()) send(state);
						for (const request of host.nativeUi.pending()) send({ t: "native-ui", request });
					}
				} catch (error) {
					disposeBrowser();
					disposeBusiness();
					send({ t: "error", message: error instanceof Error ? error.message : String(error) });
				}
			},
			message(socket) {
				socket.send(
					JSON.stringify({ t: "error", message: "Submit explicit actions through the same-origin HTTP API" }),
				);
			},
			close: disconnect,
		},
	});
	const urls = allowedAddresses.map(address => `http://${address}:${server.port}${prefix}`);
	let closePromise: Promise<void> | undefined;
	return {
		url: urls[0],
		urls,
		loopbackUrl: `http://127.0.0.1:${server.port}${prefix}`,
		close() {
			if (!closePromise) {
				const pending = (async () => {
					for (const socket of connections) {
						disconnect(socket);
						socket.close(1001, "Dev mode exited");
					}
					await Promise.all([...closing]);
					await server.stop(true);
				})();
				closePromise = pending;
				void pending.catch(() => {
					if (closePromise === pending) closePromise = undefined;
				});
			}
			return closePromise;
		},
	};
}
