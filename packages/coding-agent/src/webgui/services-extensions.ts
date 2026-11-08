import { ServiceChannels } from "../../../../vendor/zcode-frontend/packages/shared/src/channels";
import type { CommandsListResult } from "../../../../vendor/zcode-frontend/packages/shared/src/command-types";
import type {
	DataSyncContentHashesResult,
	DataSyncListResult,
	RemoteSyncWriteAccessResult,
} from "../../../../vendor/zcode-frontend/packages/shared/src/remote-sync";
import type { SettingsSyncClaudeAgentsFileMigrationStatus } from "../../../../vendor/zcode-frontend/packages/shared/src/settings-sync";
import type { SkillsListResult } from "../../../../vendor/zcode-frontend/packages/shared/src/skills-types";
import type { AgentsListResult } from "../../../../vendor/zcode-frontend/packages/shared/src/subagents-types";
import type { WebGuiMethod, WebGuiServiceContext, WebGuiServiceDefinition } from "./rpc-contract";
import { createNativeMcpMethods } from "./native-mcp";
import { createNativeSkillMethods } from "./native-skills";
import { createWebGuiService } from "./service-channel";

const unavailableReason = "OMP WebGUI protocol is connected; native extension configuration is not bound.";

/** Only this connection's unbound catalog is visible; no native directories are read or created. */
function disabledSyncReads(): Readonly<Record<string, WebGuiMethod>> {
	return {
		listSyncItems: (): DataSyncListResult => ({
			items: [],
			homeDir: "",
			importBlockedReason: "unsupported-source",
		}),
		getSyncContentHashes: (): DataSyncContentHashesResult => ({ hashes: {} }),
		checkSyncWriteAccess: (): RemoteSyncWriteAccessResult => ({
			ok: false,
			path: "",
			error: unavailableReason,
		}),
	};
}

/** Read-only native catalogs with explicit unavailable mutation boundaries. */
export function createExtensionServices(context: WebGuiServiceContext): readonly WebGuiServiceDefinition[] {
	return [
		createWebGuiService(ServiceChannels.Skills, {
			list: (): SkillsListResult => ({
				skills: [],
				capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
				diagnostics: [],
			}),
			...(context.nativeSession ? createNativeSkillMethods(context) : {}),
			// TODO(omp-skills): Bind setEnabled/buildPromptContext/copyToCommon/removeFromCommon/deleteSkill.
			// Missing business methods use the channel's explicit OMP_WEBGUI_NOT_IMPLEMENTED dispatch.
		}),
		createWebGuiService(ServiceChannels.SkillSync, {
			...disabledSyncReads(),
			// TODO(omp-skills): Bind native listSyncItems/getSyncContentHashes/checkSyncWriteAccess;
			// exportSyncItems/importSyncItems remain explicitly unavailable, never successful empty imports.
		}),
		createWebGuiService(ServiceChannels.McpSync, {
			...disabledSyncReads(),
			...createNativeMcpMethods(context),
			// Reads require the bound owner's live manager and expose its loaded cache only.
			// Export/import/trust/save operations remain unavailable.
		}),
		createWebGuiService(ServiceChannels.UserConfigSync, {
			...disabledSyncReads(),
			// TODO(omp-native-settings): Bind category-specific native sync reads;
			// exportSyncItems/importSyncItems must reject until OMP user configuration is connected.
		}),
		createWebGuiService(ServiceChannels.Subagents, {
			list: (): AgentsListResult => ({
				agents: [],
				userAgents: [],
				pluginAgents: [],
				capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
				diagnostics: [],
			}),
			// TODO(omp-native-settings): Bind subagent discovery; setEnabled/setBuiltInModelOverride,
			// setPluginAgentModelOverride/getPrimaryUserAgentsDirectory/createAgent/updateAgent/deleteAgent
			// remain unavailable. In particular no nonexistent directory is advertised as available.
		}),
		createWebGuiService(ServiceChannels.Commands, {
			list: (): CommandsListResult => ({
				commands: [],
				userCommands: [],
				pluginCommands: [],
				capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
			}),
			// TODO(omp-native-settings): Bind command discovery; writeCommandFile/updateCommandFile,
			// deleteCommandFile/setCommandEnabled/getPrimaryUserCommandsDirectory remain unavailable.
		}),
		createWebGuiService(ServiceChannels.Hooks, {
			// TODO(omp-native-settings): Bind native hook discovery and authority;
			// saveHooks/grantWorkspaceHookTrust remain unavailable, never grant fabricated trust.
		}),
		createWebGuiService(ServiceChannels.Memory, {
			// TODO(omp-native-settings): Bind native memory discovery; saveMemory/clearMemory,
			// getUserMemoryDirectory/readProjectMemoryFile remain unavailable (including directory creation).
		}),
		createWebGuiService(ServiceChannels.OutputStyle, {
			// TODO(omp-native-settings): Bind native output style discovery; addStyle/updateStyle/deleteStyle,
			// getUserStylesDirectory/setActiveStyle remain unavailable.
		}),
		createWebGuiService(ServiceChannels.SettingsSync, {
			getClaudeAgentsFileMigrationStatus: (): SettingsSyncClaudeAgentsFileMigrationStatus => ({
				sourcePath: "",
				targetPath: "",
				sourceExists: false,
				targetExists: false,
				supported: false,
			}),
			// TODO(omp-native-settings): Bind native migration status/discovery/first-run persistence;
			// copyClaudeAgentsFileToZcodeAgentsFile/importSelected/markFirstRunPromptHandled stay unavailable.
			// Browser startup must gate native migration, not pretend the first-run prompt was handled.
		}),
	];
}
