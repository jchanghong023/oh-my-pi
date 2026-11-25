import { isCollab2RoomNumber, NumberedRoomError } from "../collab/numbered-room";
import { refuseImages } from "./helpers/draft";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_COLLAB2_SLASH_COMMAND: SlashCommandSpec = {
	name: "collab2",
	icon: "broadcast",
	description: "Host or join collaboration by room number",
	inlineHint: "<room-number> | join <room-number> | stop",
	allowArgs: true,
	async handleTui(command, runtime) {
		if (refuseImages(command, runtime)) return;
		const ctx = runtime.ctx;
		if (!runtime.draftDetached && ctx.composer.expandedText().trim() === command.text.trim()) {
			ctx.composer.setText("");
		}
		const [verb, argument, extra] = command.args.split(/\s+/);
		const joining = verb === "join";
		const stopping = verb === "stop" && argument === undefined;
		const roomNumber = joining ? argument : verb;
		if (!stopping && (!roomNumber || !isCollab2RoomNumber(roomNumber) || (joining ? extra : argument))) {
			ctx.showError("Usage: /collab2 <room-number> | /collab2 join <room-number> | /collab2 stop");
			return;
		}
		try {
			if (stopping) {
				const stopped = await ctx.collabController.stopNumberedRoom();
				ctx.showStatus(stopped ? "Collab2 room stopped" : "No hosted Collab2 room to stop");
			} else if (roomNumber) {
				if (joining) {
					await ctx.collabController.joinNumberedRoom(roomNumber);
				} else {
					const host = await ctx.collabController.startNumberedRoom(roomNumber);
					if (ctx.collabController.host === host && host.relayConnected) ctx.showStatus("Collab2 room opened");
				}
			}
		} catch (err) {
			ctx.showError(err instanceof NumberedRoomError ? err.message : "Collab2 room is unavailable");
		}
	},
};
