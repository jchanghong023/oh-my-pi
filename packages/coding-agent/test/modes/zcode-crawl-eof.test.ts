import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { command, create, deadline, fixture, output, ProcessPeer, subscribe } from "./zcode-process-harness";

test("desktop crawl cancellation releases the global relay broker on EOF", async () => {
	await using root = await TempDir.create("@zcode-crawl-eof-");
	await using config = await fixture(root);
	const probed = Promise.withResolvers<void>();
	const relay = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname !== "/json/version") return new Response(null, { status: 404 });
			probed.resolve();
			return new Response(null, { status: 503 });
		},
	});
	try {
		await fs.appendFile(
			path.join(config.agentDir, "config.yml"),
			`browser:\n  relay: true\n  relayUrl: http://127.0.0.1:${relay.port}\n`,
		);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const sessionId = await create(peer, config.cwdA);
		await subscribe(peer, sessionId);
		expect(
			await command(peer, sessionId, "sendText", { text: `/crawl http://127.0.0.1:${relay.port}/page` }),
		).toMatchObject({ status: "accepted" });

		// Relay auto-start pings the global broker before probing an existing server.
		await deadline(probed.promise);
		expect(await command(peer, sessionId, "sendText", { text: "/crawl stop" })).toMatchObject({
			status: "accepted",
		});
		await output(peer, sessionId, "Crawl cancelled: 0 saved, 0 failed; saved files retained.");
		expect(await peer.eof()).toBe(0);
		expect(config.requests).toHaveLength(0);
	} finally {
		relay.stop(true);
	}
}, 120_000);
