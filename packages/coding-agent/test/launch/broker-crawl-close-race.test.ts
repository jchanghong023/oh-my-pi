// Real IPC is needed to observe whether a cancelled request reaches the broker and
// whether a connection that completes after close is actually released.
import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerEndpoint } from "../../src/launch/paths";

for (const action of ["abort", "close"] as const) {
	test(`broker ${action} while connecting does not send the request or retain the socket`, async () => {
		using tempDir = TempDir.createSync("@omp-broker-connect-race-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir });
		const frames: string[] = [];
		const peerClosed = Promise.withResolvers<void>();
		let peer: IpcConnection | undefined;
		const server = await IpcServer.listen(daemonBrokerEndpoint(runtimeDir), { framing: "lines" }, connection => {
			peer = connection;
			connection.start(
				line => {
					frames.push(line);
					const { id } = JSON.parse(line) as { id: string };
					connection.send(JSON.stringify({ id, ok: true, result: { op: "ping", projectDir } }));
				},
				() => peerClosed.resolve(),
			);
		});
		const connected = Promise.withResolvers<void>();
		const releaseConnect = Promise.withResolvers<void>();
		const connect = IpcConnection.connect.bind(IpcConnection);
		// Hold a real established connection before returning it to the client.
		const connectSpy = spyOn(IpcConnection, "connect").mockImplementation(async (endpoint, options) => {
			const socket = await connect(endpoint, options);
			connected.resolve();
			await releaseConnect.promise;
			return socket;
		});
		const controller = new AbortController();
		const request = client.request({ op: "ping" }, controller.signal).then(
			() => null,
			error => error,
		);
		try {
			await connected.promise;
			if (action === "abort") controller.abort();
			else client.close();
			releaseConnect.resolve();
			const error = await request;
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain(action === "abort" ? "aborted" : "closed");
			client.close();
			await peerClosed.promise;
			expect(frames).toEqual([]);
		} finally {
			releaseConnect.resolve();
			client.close();
			peer?.destroy();
			connectSpy.mockRestore();
			await server.close();
		}
	}, 15_000);
}
