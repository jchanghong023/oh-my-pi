import { createConnection } from "node:net";

export interface Firefox68Marionette {
	command<T>(name: string, parameters?: object): Promise<T>;
	close(): void;
}

// Firefox 68's protocol-3 wire format and response wrapping are defined in:
// https://hg.mozilla.org/releases/mozilla-release/file/FIREFOX_68_0_2_RELEASE/testing/marionette/server.js
// https://hg.mozilla.org/releases/mozilla-release/file/FIREFOX_68_0_2_RELEASE/testing/marionette/transport.js
export async function connectFirefox68Marionette(port: number, timeout: number): Promise<Firefox68Marionette> {
	const socket = createConnection({ host: "127.0.0.1", port });
	const greeting = Promise.withResolvers<void>();
	const pending = new Map<
		number,
		{
			resolve(value: unknown): void;
			reject(error: Error): void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let buffer: Buffer = Buffer.alloc(0);
	let greeted = false;
	let nextId = 0;
	let failure: Error | undefined;
	const fail = (error: Error) => {
		failure ??= error;
		greeting.reject(error);
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
		socket.destroy();
	};
	const greetingTimer = setTimeout(
		() => fail(new Error("Timed out waiting for Firefox Marionette greeting")),
		timeout,
	);
	socket.on("error", fail);
	socket.on("close", () => fail(new Error("Firefox Marionette connection closed")));
	socket.on("data", chunk => {
		if (typeof chunk === "string") {
			fail(new Error("Firefox Marionette frames must remain binary"));
			return;
		}
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
		try {
			while (buffer.length) {
				const colon = buffer.indexOf(58);
				if (colon < 0) return;
				const prefix = buffer.toString("ascii", 0, colon);
				if (!/^[0-9]+$/.test(prefix)) throw new Error("Invalid Firefox Marionette frame length");
				const length = Number(prefix);
				if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Invalid Firefox Marionette frame size");
				if (buffer.length - colon - 1 < length) return;
				const message: unknown = JSON.parse(buffer.toString("utf8", colon + 1, colon + 1 + length));
				buffer = buffer.subarray(colon + 1 + length);
				if (!greeted) {
					if (
						typeof message !== "object" ||
						message === null ||
						!("marionetteProtocol" in message) ||
						message.marionetteProtocol !== 3 ||
						!("applicationType" in message) ||
						message.applicationType !== "gecko"
					)
						throw new Error(`Unexpected Firefox Marionette greeting: ${JSON.stringify(message)}`);
					greeted = true;
					greeting.resolve();
					continue;
				}
				if (!Array.isArray(message) || message.length !== 4 || message[0] !== 1 || !Number.isInteger(message[1]))
					throw new Error(`Invalid Firefox Marionette response: ${JSON.stringify(message)}`);
				const request = pending.get(message[1]);
				if (!request) throw new Error(`Unexpected Firefox Marionette response id ${message[1]}`);
				pending.delete(message[1]);
				clearTimeout(request.timer);
				if (message[2] !== null) {
					const error = message[2] as { error?: string; message?: string; stacktrace?: string };
					request.reject(
						Object.assign(new Error(`Marionette: ${error.message ?? JSON.stringify(error)}`), {
							webdriverError: error.error,
							marionetteStack: error.stacktrace,
						}),
					);
				} else {
					const body = message[3];
					// server.js wraps primitive values and element references, while
					// object/array results (including NewWindow) are returned directly.
					request.resolve(
						body !== null &&
							typeof body === "object" &&
							!Array.isArray(body) &&
							Object.prototype.hasOwnProperty.call(body, "value")
							? body.value
							: body,
					);
				}
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
	try {
		await greeting.promise;
	} finally {
		clearTimeout(greetingTimer);
	}
	return {
		command<T>(name: string, parameters: object = {}): Promise<T> {
			if (failure) return Promise.reject(failure);
			const id = ++nextId;
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(
					() => fail(new Error(`Timed out waiting for Marionette ${name} (${id})`)),
					timeout,
				);
				pending.set(id, { resolve: value => resolve(value as T), reject, timer });
				const message = Buffer.from(JSON.stringify([0, id, name, parameters]), "utf8");
				socket.write(`${message.length}:`);
				socket.write(message);
			});
		},
		close() {
			fail(new Error("Owned Firefox Marionette client closed"));
		},
	};
}
