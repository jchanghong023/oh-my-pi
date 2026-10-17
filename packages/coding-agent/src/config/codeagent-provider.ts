import type { AssistantMessageEvent, Context, Model } from "@oh-my-pi/pi-ai/types";
import { NO_AUTH_SENTINEL } from "@oh-my-pi/pi-ai/auth-retry";
import {
	setCodeAgentStreamHandler,
	streamOpenAICompletionsOnce,
	type OpenAICompletionsOptions,
} from "@oh-my-pi/pi-ai/providers/openai-completions";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { logger } from "@oh-my-pi/pi-utils";

export const CODEAGENT_PROVIDER_ID = "codeagent";
export const CODEAGENT_TOKEN_VALUE = "JCH_CODEAGENT3_X_AUTH_TOKEN";

/** 直接查询当前用户注册表；绝不使用进程环境变量中的 Token 快照。 */
export function readCodeAgentRegistryToken(): string | undefined {
	if (process.platform !== "win32") return undefined;
	try {
		const result = Bun.spawnSync(["reg.exe", "query", "HKCU\\Environment", "/v", CODEAGENT_TOKEN_VALUE], {
			stdout: "pipe",
			stderr: "ignore",
			timeout: 2000,
		});
		if (result.exitCode !== 0) return undefined;
		const match = result.stdout.toString().match(/^[\t ]*JCH_CODEAGENT3_X_AUTH_TOKEN[\t ]+REG_SZ[\t ]+(\S[^\r\n]*)/m);
		return match?.[1] || undefined;
	} catch {
		return undefined;
	}
}

export class CodeAgentTokenCache {
	#token: string | undefined;
	constructor(private readonly readToken: () => string | undefined = readCodeAgentRegistryToken) {
		this.refresh();
	}
	get token(): string | undefined {
		return this.#token;
	}
	refresh(): string | undefined {
		try {
			const token = this.readToken();
			// 读取失败或无效值不清空已缓存的凭据，也不记录异常载荷。
			if (token && !/[\r\n\0]/.test(token)) this.#token = token;
		} catch {}
		return this.#token;
	}
}

let cache: CodeAgentTokenCache | undefined;
let models: Model<"openai-completions">[] | undefined;

export function getCodeAgentModels(): Model<"openai-completions">[] {
	return (models ??= seedModels<"openai-completions">(CODEAGENT_PROVIDER_ID).map(spec => buildModel(spec)));
}

/** 注册表快照在正常 registry 启动读取一次；旧会话与旧模型对象共享活缓存。 */
export function initializeCodeAgentProvider(initialCache?: CodeAgentTokenCache): void {
	if (initialCache) cache = initialCache;
	if (!cache) {
		cache = new CodeAgentTokenCache();
		logger.info("CodeAgent credential cache initialized", {
			provider: CODEAGENT_PROVIDER_ID,
			available: !!cache.token,
		});
	}
	setCodeAgentStreamHandler((model, context, options) => streamCodeAgent(model, context, options, cache!));
}

function commitsAttempt(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "toolcall_start":
		case "toolcall_end":
		case "image_end":
			return true;
		default:
			return false;
	}
}

/** 仅 Token 发生变化时重试一次；任何已输出的正文、思考或工具事件都禁止重放。 */
export function streamCodeAgent(
	model: Model<"openai-completions">,
	context: Context,
	options: OpenAICompletionsOptions | undefined,
	tokenCache: CodeAgentTokenCache,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();
	void (async () => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = tokenCache.token;
			let committed = false;
			const buffered: AssistantMessageEvent[] = [];
			const flush = () => {
				for (const event of buffered) outer.push(event);
				buffered.length = 0;
			};
			const baseFetch = options?.fetch ?? fetch;
			const inner = streamOpenAICompletionsOnce(model, context, {
				...options,
				apiKey: NO_AUTH_SENTINEL,
				// 错误 SSE 不进入原始诊断日志；终端错误由底层安全归一化。
				onSseEvent: undefined,
				fetch: async (input, init) => {
					const headers = new Headers(init?.headers);
					headers.delete("authorization");
					headers.delete("x-api-key");
					headers.delete("api-key");
					headers.delete("x-auth-token");
					if (token) headers.set("x-auth-token", token);
					return baseFetch(input, { ...init, headers, redirect: init?.redirect ?? "error" });
				},
			});
			let replay = false;
			for await (const event of inner) {
				if (event.type === "error") {
					const next = tokenCache.refresh();
					replay =
						attempt === 0 &&
						!committed &&
						!options?.signal?.aborted &&
						event.reason !== "aborted" &&
						next !== token;
					logger.info("CodeAgent request failed", {
						provider: CODEAGENT_PROVIDER_ID,
						token_changed: next !== token,
						retry: replay,
						output_committed: committed,
					});
					if (replay) break;
					flush();
					outer.push(event);
					return;
				}
				if (event.type === "done") {
					flush();
					outer.push(event);
					return;
				}
				if (!committed && !commitsAttempt(event)) buffered.push(event);
				else {
					committed = true;
					flush();
					outer.push(event);
				}
			}
			if (!replay) {
				flush();
				outer.end(await inner.result());
				return;
			}
		}
	})().catch(() => {
		// 不向调用者或日志透传可能包含 Token 的底层异常。
		tokenCache.refresh();
		outer.fail(new Error("CodeAgent request failed"));
	});
	return outer;
}
