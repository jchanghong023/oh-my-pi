import { decodeBase64ImageData, parseImageMetadata } from "@oh-my-pi/pi-utils";
import { MAX_IMAGE_INPUT_BYTES } from "../utils/image-input";
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

/** One capability-protected, loopback-only sketch session, ready on return. */
export function startSketchServer(): SketchServer {
	const path = `/sketch/${crypto.randomUUID()}/`;
	const { promise, resolve } = Promise.withResolvers<Buffer | null>();
	let settled = false;
	let origin = "";

	function reply(message: string, status = 200): Response {
		return new Response(message, {
			status,
			headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
		});
	}

	function complete(value: Buffer | null): Response {
		if (settled) return reply("绘图会话已结束。", 409);
		settled = true;
		// Graceful stop keeps the browser's acknowledgement alive even if the consumer calls close().
		void server.stop(false);
		resolve(value);
		return reply("OK");
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		maxRequestBodySize: MAX_ENCODED_BYTES,
		async fetch(request) {
			const url = new URL(request.url);
			const requestOrigin = request.headers.get("origin");
			if (url.origin !== origin || (requestOrigin !== null && requestOrigin !== origin)) {
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
			if (contentLength !== null && Number(contentLength) > MAX_ENCODED_BYTES) {
				return reply("图片超过附件大小限制。", 413);
			}
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
				// Decode at thumbnail size; the original PNG bytes become the attachment.
				await new Bun.Image(bytes).resize(1, 1).png().bytes();
			} catch {
				return reply("无法解码 PNG 图片。", 400);
			}
			return complete(bytes);
		},
	});
	origin = `http://127.0.0.1:${server.port}`;

	return {
		url: `${origin}${path}`,
		result: promise,
		close() {
			if (settled) return;
			settled = true;
			resolve(null);
			void server.stop(true);
		},
	};
}
