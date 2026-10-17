/**
 * Bytes of a request body as the server reads them: `Content-Encoding: gzip`
 * (applied by the Anthropic transport to large official-API bodies) is undone,
 * any other encoding is returned untouched.
 */
export function decodeRequestBodyBytes(bytes: Uint8Array, contentEncoding: string | null): Uint8Array {
	if (contentEncoding?.trim().toLowerCase() !== "gzip") return bytes;
	return Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>);
}

/**
 * Text of a string or byte request body after undoing its content encoding;
 * `undefined` when the request has no such body (none, stream, form data).
 */
export function requestBodyText(init: RequestInit | undefined): string | undefined {
	const body = init?.body;
	if (typeof body === "string") return body;
	if (!(body instanceof Uint8Array)) return undefined;
	const encoding = new Headers(init?.headers).get("content-encoding");
	return new TextDecoder().decode(decodeRequestBodyBytes(body, encoding));
}
