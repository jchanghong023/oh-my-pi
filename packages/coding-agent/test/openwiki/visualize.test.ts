import { describe, expect, it, spyOn } from "bun:test";
import { watch } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { loadOpenWikiVendor } from "../../src/openwiki/vendor-loader";
import { getOpenWikiVisualAssets } from "../../src/openwiki/visual-assets";

describe("OMP embedded OpenWiki visualizer", () => {
	// Real loopback HTTP, graph content, SSE rebuild, and listener disposal; no browser or model.
	it("serves actual pages, broadcasts refresh and releases the loopback listener on close", async () => {
		using dir = TempDir.createSync("@omp-openwiki-live-");
		const wikiRoot = dir.join("openwiki");
		await mkdir(wikiRoot);
		const page = dir.join("openwiki", "quickstart.md");
		await writeFile(page, "---\ntitle: Quickstart\ntype: Guide\n---\n# Quickstart\n\nLIVE_INITIAL_BEACON\n");
		const vendor = await loadOpenWikiVendor();
		const assets = await getOpenWikiVisualAssets();
		const server = await vendor.startEmbeddedVisualizeServer({ wikiRoot, port: 0, open: false, assets });
		let cancelEvents: (() => Promise<void>) | undefined;
		try {
			expect(new URL(server.url).hostname).toBe("127.0.0.1");
			const html = await fetch(server.url);
			expect(html.status).toBe(200);
			expect(html.headers.get("content-type")).toContain("text/html");
			expect(await html.text()).toContain("client.js");
			const graph = await fetch(`${server.url}/api/graph`);
			expect(await graph.text()).toContain("LIVE_INITIAL_BEACON");
			const events = await fetch(`${server.url}/events`, { signal: AbortSignal.timeout(10_000) });
			expect(events.headers.get("content-type")).toBe("text/event-stream");
			const reader = events.body!.getReader();
			cancelEvents = () => reader.cancel();
			expect(new TextDecoder().decode((await reader.read()).value)).toContain("retry:");
			await writeFile(page, "---\ntitle: Quickstart\ntype: Guide\n---\n# Quickstart\n\nLIVE_UPDATED_BEACON\n");
			let received = "";
			while (!received.includes("event: reload")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error(`Visualizer events ended without refresh: ${received}`);
				received += new TextDecoder().decode(chunk.value);
			}
			const updated = await (await fetch(`${server.url}/api/graph`)).text();
			expect(updated).toContain("LIVE_UPDATED_BEACON");
			expect(updated).not.toContain("LIVE_INITIAL_BEACON");
			await reader.cancel();
			cancelEvents = undefined;
			await server.close();
			await server.close();
			const replacement = Bun.serve({
				hostname: "127.0.0.1",
				port: Number(new URL(server.url).port),
				fetch: () => new Response("host task still alive"),
			});
			try {
				expect(await (await fetch(server.url)).text()).toBe("host task still alive");
			} finally {
				replacement.stop(true);
			}
		} finally {
			await cancelEvents?.().catch(() => {});
			await server.close();
		}
	}, 30_000);

	// A startup failure must reject to the host instead of terminating its other tasks.
	it("reports a missing wiki without terminating the embedding host", async () => {
		using dir = TempDir.createSync("@omp-openwiki-live-failure-");
		const vendor = await loadOpenWikiVendor();
		const unrelated = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated task") });
		try {
			await expect(
				vendor.startEmbeddedVisualizeServer({
					wikiRoot: dir.join("missing"),
					port: 0,
					open: false,
					assets: await getOpenWikiVisualAssets(),
				}),
			).rejects.toThrow("Wiki directory not found");
			expect(await (await fetch(unrelated.url)).text()).toBe("unrelated task");
		} finally {
			unrelated.stop(true);
		}
	}, 30_000);
	// Observe a child change before removing the root: moving a watched root alone
	// need not notify a recursive watcher on Windows.
	it("reports refresh failure without exiting or killing unrelated host tasks", async () => {
		using dir = TempDir.createSync("@omp-openwiki-refresh-error-");
		const wikiRoot = dir.join("openwiki");
		await mkdir(wikiRoot);
		const page = dir.join("openwiki", "quickstart.md");
		await writeFile(page, "# Quickstart\nREFRESH_SAVED_GRAPH\n");
		const vendor = await loadOpenWikiVendor();
		const server = await vendor.startEmbeddedVisualizeServer({
			wikiRoot,
			port: 0,
			open: false,
			assets: await getOpenWikiVisualAssets(),
		});
		const failure = Promise.withResolvers<string>();
		const changed = Promise.withResolvers<void>();
		const observer = watch(wikiRoot, () => changed.resolve());
		const unrelated = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unrelated task") });
		const writeStderr = process.stderr.write.bind(process.stderr);
		const capture = spyOn(process.stderr, "write").mockImplementation(
			(
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
				callback?: (error?: Error | null) => void,
			) => {
				const message = String(chunk);
				if (message.includes("visualizer refresh failed")) failure.resolve(message);
				if (typeof encodingOrCallback === "function") return writeStderr(chunk, encodingOrCallback);
				return writeStderr(chunk, encodingOrCallback, callback);
			},
		);
		const timer = setTimeout(
			() => failure.reject(new Error("Visualizer did not report its refresh failure")),
			10_000,
		);
		try {
			await writeFile(page, "# Quickstart\nREFRESH_PENDING_GRAPH\n");
			await Promise.race([changed.promise, failure.promise]);
			await rename(wikiRoot, dir.join("moved-wiki"));
			expect(await failure.promise).toContain("visualizer refresh failed");
			expect(await (await fetch(`${server.url}/api/graph`)).text()).toContain("REFRESH_SAVED_GRAPH");
			expect(await (await fetch(unrelated.url)).text()).toBe("unrelated task");
		} finally {
			clearTimeout(timer);
			observer.close();
			unrelated.stop(true);
			capture.mockRestore();
			await server.close();
		}
	}, 30_000);
});
