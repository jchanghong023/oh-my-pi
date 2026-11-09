import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils/stream";
import { gracefulKillTreeOnce } from "../packages/coding-agent/src/tools/browser/attach";

export interface FirefoxSelenium {
	command<T>(name: string, parameters?: object): Promise<T>;
	close(): Promise<void>;
}

/** Selenium owns geckodriver and the isolated Firefox process; no native protocol client. */
export function connectFirefoxSelenium(timeout: number, environment?: Record<string, string>): FirefoxSelenium {
	const child = Bun.spawn(
		[
			environment?.PYTHON_EXECUTABLE ?? process.env.PYTHON_EXECUTABLE ?? "python",
			path.join(import.meta.dir, "webgui-firefox-selenium.py"),
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env },
	);
	const diagnostics = new Response(child.stderr).text();
	const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: Timer }>();
	let nextId = 0;
	let failure: Error | undefined;
	const fail = (error: Error) => {
		failure ??= error;
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		pending.clear();
	};
	const pump = (async () => {
		const decoder = new TextDecoder();
		try {
			for await (const line of readLines(child.stdout)) {
				const result = JSON.parse(decoder.decode(line)) as {
					id: number;
					value?: unknown;
					error?: string;
				};
				const request = pending.get(result.id);
				if (!request) throw new Error(`Unexpected Selenium response ${result.id}`);
				pending.delete(result.id);
				clearTimeout(request.timer);
				if (result.error) request.reject(new Error(result.error));
				else request.resolve(result.value);
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	})();
	void child.exited.then(async code => {
		await pump;
		fail(new Error(`Selenium Firefox bridge exited ${code}: ${await diagnostics}`));
	});
	return {
		command<T>(name: string, parameters: object = {}): Promise<T> {
			if (failure) return Promise.reject(failure);
			const id = ++nextId;
			const deferred = Promise.withResolvers<T>();
			const timer = setTimeout(() => {
				fail(new Error(`Timed out waiting for Selenium ${name}`));
				void gracefulKillTreeOnce(child.pid);
			}, timeout);
			pending.set(id, { resolve: value => deferred.resolve(value as T), reject: deferred.reject, timer });
			try {
				child.stdin.write(`${JSON.stringify({ id, name, parameters })}\n`);
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
			return deferred.promise;
		},
		async close() {
			child.stdin.end();
			if (failure && child.exitCode === null) await gracefulKillTreeOnce(child.pid);
			await child.exited;
			await pump;
		},
	};
}
