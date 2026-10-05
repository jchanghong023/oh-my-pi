import { afterEach, describe, expect, test, type Mock, spyOn } from "bun:test";
import { CollabHost, CollabHostStoppedError } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { CollabRoomIdentity } from "@oh-my-pi/pi-coding-agent/collab/identity";
import { CollabSocket, RELAY_CLOSE_REASONS } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function startupContext(): InteractiveModeContext {
	return {
		settings: Settings.isolated(),
		sessionManager: { getSessionId: () => "startup-session" },
		statusLine: { setCollabStatus: () => {}, invalidate: () => {} },
		ui: { requestRender: () => {} },
	} as unknown as InteractiveModeContext;
}

afterEach(() => {
	connectSpy?.mockRestore();
	connectSpy = undefined;
});

let connectSpy: Mock<typeof CollabSocket.prototype.connect> | undefined;

describe("collab host startup close", () => {
	test("reports the competing session when the relay rejects startup with 4009", async () => {
		connectSpy = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			this.onClose?.(RELAY_CLOSE_REASONS[4009], false);
		});
		const host = new CollabHost(startupContext());
		await expect(host.start("ws://localhost:8789")).rejects.toThrow(
			"relay connection closed during startup: a host is already connected for this room" +
				" (another omp session hosts this room; /collab list shows it)",
		);
		expect(host.stopped).toBe(true);
	});

	test("reports a terminal startup refusal without a duplicate-host hint", async () => {
		connectSpy = spyOn(CollabSocket.prototype, "connect").mockImplementation(function (this: CollabSocket) {
			this.onClose?.(RELAY_CLOSE_REASONS[4029], false);
		});
		const host = new CollabHost(startupContext());
		await expect(host.start("ws://localhost:8789")).rejects.toThrow(
			"relay connection closed during startup: room is full",
		);
		expect(host.stopped).toBe(true);
	});

	test("stop aborts a pending identity read and releases retained dialogs before connecting", async () => {
		connectSpy = spyOn(CollabSocket.prototype, "connect").mockImplementation(() => {});
		const identity = Promise.withResolvers<CollabRoomIdentity>();
		const host = new CollabHost(startupContext(), { identity: identity.promise });
		const pending = host.requestGuestUi({ kind: "editor", title: "Early question" });
		const started = host.start("ws://localhost:8789");
		started.catch(() => {});
		await host.stop("cancelled while loading identity");
		await expect(started).rejects.toBeInstanceOf(CollabHostStoppedError);
		expect(await pending).toEqual({ kind: "unavailable" });
		expect(connectSpy).not.toHaveBeenCalled();
	});
});
