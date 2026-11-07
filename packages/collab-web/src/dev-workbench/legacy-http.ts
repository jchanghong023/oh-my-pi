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
export function workbenchHttp(url: URL, options: WorkbenchHttpOptions = {}): Promise<WorkbenchHttpResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<WorkbenchHttpResponse>();
	try {
		if (url.origin !== window.location.origin) {
			reject(new TypeError("Dev requests must stay on the page origin"));
			return promise;
		}
		const request = new XMLHttpRequest();
		request.open(options.method ?? "GET", url.href, true);
		// XHR sends same-origin cookies by default; never opt into cross-origin credentials.
		request.withCredentials = false;
		if (options.contentType) request.setRequestHeader("Content-Type", options.contentType);
		request.onload = () => {
			if (request.status === 0) {
				reject(new TypeError("Network request failed"));
				return;
			}
			resolve({
				ok: request.status >= 200 && request.status < 300,
				status: request.status,
				text: request.responseText,
				header: name => request.getResponseHeader(name),
			});
		};
		request.onerror = () => reject(new TypeError("Network request failed"));
		request.onabort = () => reject(new TypeError("Network request aborted"));
		request.ontimeout = () => reject(new TypeError("Network request timed out"));
		request.send(options.body ?? null);
	} catch (error) {
		reject(error);
	}
	return promise;
}
