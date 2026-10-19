import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { TeamConfigError, TeamConfigService } from "../../team/config";
import type { RpcTeamCommand } from "./rpc-fork-types";
import type { RpcResponse } from "./rpc-types";

/** Namespace guard only: the shared service validates every untrusted payload at runtime. */
export function isRpcTeamConfigCommand(value: unknown): value is RpcTeamCommand {
	return (
		isRecord(value) &&
		(value.type === "get_team_config" || value.type === "get_team_models" || value.type === "set_team_config")
	);
}

/** One request's captured host context, never getters following a switched session. */
export interface RpcTeamConfigContext {
	readonly settings: Settings;
	readonly modelRegistry: ModelRegistry;
	readonly sessionModel: Model | undefined;
	readonly isCurrent: () => boolean;
	readonly emit: (frame: object) => void;
}

/** Namespace/transport adaptation only; all runtime validation belongs to the shared service. */
export class RpcTeamConfigAdapter {
	readonly #service: TeamConfigService;

	constructor(context: RpcTeamConfigContext) {
		this.#service = new TeamConfigService({
			getSettings: () => context.settings,
			getModelRegistry: () => context.modelRegistry,
			getSessionModel: () => context.sessionModel,
			isCurrent: context.isCurrent,
			emit: frame => {
				if (context.isCurrent()) context.emit(frame);
			},
		});
	}

	async handle(command: RpcTeamCommand, negotiated: boolean): Promise<RpcResponse> {
		const { id, type } = command;
		if (!negotiated) {
			return {
				id,
				type: "response",
				command: type,
				success: false,
				code: "unsupported",
				error: "Team configuration requires negotiate_protocol {protocolVersion:3} and capabilities.teamConfig",
			};
		}
		try {
			switch (type) {
				case "get_team_config":
					return {
						id,
						type: "response",
						command: type,
						success: true,
						data: await this.#service.getConfig(command.preview),
					};
				case "get_team_models":
					return {
						id,
						type: "response",
						command: type,
						success: true,
						data: this.#service.getModels(command.query),
					};
				case "set_team_config":
					return {
						id,
						type: "response",
						command: type,
						success: true,
						data: await this.#service.setConfig({
							scope: command.scope,
							expectedRevision: command.expectedRevision,
							members: command.members,
						}),
					};
			}
		} catch (cause) {
			if (cause instanceof TeamConfigError) {
				return {
					id,
					type: "response",
					command: type,
					success: false,
					error: cause.message,
					code: cause.code,
					...(cause.data === undefined ? {} : { data: cause.data }),
				};
			}
			return {
				id,
				type: "response",
				command: type,
				success: false,
				code: "execution_failed",
				error: cause instanceof Error ? cause.message : String(cause),
			};
		}
	}
}
