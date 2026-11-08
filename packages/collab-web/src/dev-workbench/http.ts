export interface WorkbenchHttpResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly text: string;
	header(name: string): string | null;
}

interface WorkbenchHttpOptions {
	method?: string;
	body?: string | FormData;
	contentType?: string;
}

/** Same-origin, text-only Dev transport. Never retries a request, including an uncertain mutation. */
export async function workbenchHttp(url: URL, options: WorkbenchHttpOptions = {}): Promise<WorkbenchHttpResponse> {
	if (url.origin !== window.location.origin) throw new TypeError("Dev requests must stay on the page origin");
	let response: Response;
	let text: string;
	try {
		response = await fetch(url.href, {
			method: options.method ?? "GET",
			body: options.body,
			credentials: "same-origin",
			headers: options.contentType ? { "Content-Type": options.contentType } : undefined,
		});
		text = await response.text();
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw new TypeError("Network request aborted");
		throw new TypeError("Network request failed");
	}
	return {
		ok: response.ok,
		status: response.status,
		text,
		header: name => response.headers.get(name),
	};
}
