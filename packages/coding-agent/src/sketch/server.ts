import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-tui/chat/image-loading";
import { decodeBase64ImageData, parseImageMetadata } from "@oh-my-pi/pi-utils";
import sketchHtml from "./sketch.html" with { type: "text" };

// Bun's text loader returns a string, but its ambient *.html type describes
// HTML bundles. Narrow the embedded value without changing the asset loader.
const embeddedHtml: unknown = sketchHtml;
if (typeof embeddedHtml !== "string") throw new TypeError("Expected sketch HTML from Bun's text loader.");
const sketchHtmlText: string = embeddedHtml;

export interface SketchServer {
	readonly url: string;
	readonly result: Promise<Buffer | null>;
	close(): void;
}

const MAX_ENCODED_BYTES = 4 * Math.ceil(MAX_IMAGE_INPUT_BYTES / 3);
const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"content-security-policy":
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export interface SketchResource {
	readonly path: string;
	readonly result: Promise<Buffer | null>;
	fetch(request: Request): Promise<Response>;
	close(): void;
}

/** Canvas and PNG validation shared by terminal launch and the native in-process browser host. */
export function createSketchResource(
	options: {
		path?: string;
		origin?: () => string;
		/** Browser hosts acknowledge only after the originating draft has received the real PNG. */
		onSubmit?: (png: Buffer) => Promise<void>;
	} = {},
): SketchResource {
	const path = options.path ?? `/sketch/${crypto.randomUUID()}/`;
	const { promise, resolve } = Promise.withResolvers<Buffer | null>();
	let settled = false;
	let completing = false;
	function reply(message: string, status = 200): Response {
		return new Response(message, {
			status,
			headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
		});
	}
	async function complete(value: Buffer | null): Promise<Response> {
		if (settled || completing) return reply("绘图会话已结束或正在添加附件。", 409);
		completing = true;
		try {
			if (value && options.onSubmit) await options.onSubmit(value);
			settled = true;
			resolve(value);
			return reply("OK");
		} catch (error) {
			return reply(error instanceof Error ? error.message : "添加绘图附件失败。", 409);
		} finally {
			completing = false;
		}
	}
	return {
		path,
		result: promise,
		close() {
			if (settled) return;
			settled = true;
			resolve(null);
		},
		async fetch(request) {
			const url = new URL(request.url);
			const requestOrigin = request.headers.get("origin");
			if (
				(options.origin && url.origin !== options.origin()) ||
				(requestOrigin !== null && requestOrigin !== url.origin)
			) {
				return reply("不允许此请求来源。", 403);
			}
			if (url.pathname !== path && url.pathname !== `${path}submit` && url.pathname !== `${path}cancel`) {
				return reply("未找到页面。", 404);
			}
			if (settled) return reply("绘图会话已结束。", 409);
			if (request.method === "GET" && url.pathname === path) {
				return new Response(sketchHtmlText, {
					headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" },
				});
			}
			if (request.method !== "POST" || url.pathname === path) return reply("不支持此请求方法。", 405);
			if (url.pathname === `${path}cancel`) return complete(null);
			const contentLength = request.headers.get("content-length");
			if (contentLength !== null && Number(contentLength) > MAX_ENCODED_BYTES)
				return reply("图片超过附件大小限制。", 413);
			let body: string;
			try {
				body = await request.text();
			} catch {
				return reply("无法读取图片数据或图片超过附件大小限制。", 413);
			}
			if (body.length > MAX_ENCODED_BYTES) return reply("图片超过附件大小限制。", 413);
			const decoded = decodeBase64ImageData(body);
			if (decoded.reason !== undefined) return reply("需要 Base64 编码的 PNG 图片。", 400);
			const bytes = decoded.bytes;
			if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) return reply("图片超过附件大小限制。", 413);
			if (parseImageMetadata(bytes)?.mimeType !== "image/png") return reply("需要 PNG 格式的图片。", 400);
			try {
				await new Bun.Image(bytes).resize(1, 1).png().bytes();
			} catch {
				return reply("无法解码 PNG 图片。", 400);
			}
			return complete(bytes);
		},
	};
}

/** One capability-protected, loopback-only sketch session, ready on return. */
export function startSketchServer(): SketchServer {
	let origin = "";
	const resource = createSketchResource({ origin: () => origin });
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: MAX_ENCODED_BYTES,
		fetch: request => resource.fetch(request),
	});
	origin = `http://127.0.0.1:${server.port}`;
	// Keep the acknowledgement socket alive while the consumer receives the image.
	let stopped = false;
	void resource.result.then(() => {
		stopped = true;
		return server.stop(false);
	});
	return {
		url: `${origin}${resource.path}`,
		result: resource.result,
		close() {
			if (stopped) return;
			stopped = true;
			resource.close();
			void server.stop(true);
		},
	};
}
