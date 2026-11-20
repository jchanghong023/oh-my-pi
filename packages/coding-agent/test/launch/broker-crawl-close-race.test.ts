// Real IPC verifies a late connection after close is released without a hello.
import { expect, spyOn, test } from "bun:test";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { closeDaemonClient, daemonClient } from "../../src/daemon/client";
import { daemonEndpoint } from "../../src/daemon/paths";
import { IsolatedDaemon } from "../fixtures/daemon-harness";

test("closing the shared client while dialing releases the socket without sending a hello", async () => {
	const harness = await IsolatedDaemon.create();
	const frames: string[] = [];
	const peerClosed = Promise.withResolvers<void>();
	let peer: IpcConnection | undefined;
	const server = await IpcServer.listen(daemonEndpoint(), { framing: "lines" }, connection => {
		peer = connection;
		connection.start(
			line => frames.push(line),
			() => peerClosed.resolve(),
		);
	});
	const connected = Promise.withResolvers<void>();
	const releaseConnect = Promise.withResolvers<void>();
	const connect = IpcConnection.connect.bind(IpcConnection);
	const connectSpy = spyOn(IpcConnection, "connect").mockImplementation(async (endpoint, options) => {
		const socket = await connect(endpoint, options);
		connected.resolve();
		await releaseConnect.promise;
		return socket;
	});
	try {
		const pending = daemonClient().catch(error => error);
		await connected.promise;
		const closing = closeDaemonClient();
		releaseConnect.resolve();
		await closing;
		expect(await pending).toBeInstanceOf(Error);
		expect(((await pending) as Error).message).toContain("closed");
		await peerClosed.promise;
		expect(frames).toEqual([]);
	} finally {
		releaseConnect.resolve();
		peer?.destroy();
		connectSpy.mockRestore();
		await server.close();
		await harness.dispose();
	}
}, 15_000);
