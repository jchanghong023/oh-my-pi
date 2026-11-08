import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VSBuffer } from "../../../../vendor/zcode-frontend/packages/rpc/src/buffer";
import { ChannelClient } from "../../../../vendor/zcode-frontend/packages/rpc/src/channelClient";
import { Emitter, Event } from "../../../../vendor/zcode-frontend/packages/rpc/src/foundation";
import { SocketProtocol } from "../../../../vendor/zcode-frontend/packages/rpc/src/protocol";
import { WEBGUI_RPC_PATH } from "../../../../vendor/zcode-frontend/preview/session-info";
import { WebGuiRpcHost, type WebGuiSocketData } from "../../src/webgui/rpc-server";
import { hasWebGuiNativeResources } from "../../src/webgui/native-session-host";

// Exercise the production channel registration and binary wire, not a service-array snapshot.
test("WebGUI rejects the retired MCP channel without disrupting retained Skills RPC", async () => {
	expect(hasWebGuiNativeResources()).toBe(false);
	using temp = TempDir.createSync("@pi-webgui-rpc-services-");
	const rpc = new WebGuiRpcHost();
	const server = Bun.serve<WebGuiSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		websocket: rpc.websocket,
		fetch(request, host) {
			if (new URL(request.url).pathname !== WEBGUI_RPC_PATH) return new Response(null, { status: 404 });
			if (host.upgrade(request, { data: { kind: "webgui", workspacePath: temp.path() } })) return;
			return new Response("WebSocket required", { status: 426 });
		},
	});
	const socket = new WebSocket(`ws://127.0.0.1:${server.port}${WEBGUI_RPC_PATH}`);
	socket.binaryType = "arraybuffer";
	const data = new Emitter<VSBuffer>();
	const closed = new Emitter<void>();
	const protocol = new SocketProtocol({
		onData: data.event,
		onClose: closed.event,
		onEnd: Event.None,
		write: buffer => socket.send(buffer.buffer),
		end: () => socket.close(),
		drain: async () => {},
		dispose: () => socket.close(),
	});
	const client = new ChannelClient(protocol);
	socket.addEventListener("message", event => data.fire(VSBuffer.wrap(new Uint8Array(event.data))));
	socket.addEventListener("close", () => {
		closed.fire();
		client.dispose();
	});
	socket.addEventListener("error", () => client.dispose());
	try {
		const skills = client.getChannel("skills");
		expect(await skills.call("list")).toMatchObject({ skills: [] });
		const retired = client.getChannel("mcp-sync");
		await expect(retired.call("loadMcpFromUserDirectory", [])).rejects.toMatchObject({
			name: "Unknown channel",
			message: expect.stringContaining("mcp-sync"),
		});
		// Rejection must be a normal RPC error, not transport shutdown or an empty MCP catalog.
		expect(await skills.call("list")).toMatchObject({ skills: [] });
		// An unbound RPC connection must not activate composition, including during disposal.
		rpc.dispose();
		expect(hasWebGuiNativeResources()).toBe(false);
	} finally {
		client.dispose();
		protocol.dispose();
		socket.close();
		rpc.dispose();
		await server.stop(true);
		data.dispose();
		closed.dispose();
	}
}, 10_000);
