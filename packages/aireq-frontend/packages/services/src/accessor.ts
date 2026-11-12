import type { IRemoteProjectService } from "#src/remote-projects/contract.js";
import type { ITaskGroupService } from "#src/task-groups/contract.js";
import type { WindowProjectDirectoryServices } from "#src/window-project-directory/contract.js";
import type { IProjectService } from "#src/project/contract.js";
import type { IGenUiService } from "./gen-ui/contract.js";
import type { IFileService } from "./file/file.js";
import type { IMediaPreviewService } from "./media-preview/mediaPreview.js";
import type { IGitService } from "./git/git.js";
import type { IGitCheckpointService } from "./git/gitCheckpoint.js";
import type { ISystemService } from "./system/system.js";
import type { ISettingService } from "./setting/setting.js";
import type { ICredentialService } from "./credential/credential.js";
import type { IBroadcastService } from "./broadcast/broadcast.js";
import type { IZCodeTaskService } from "./session/zcodeTaskService.js";
import type { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import type { ICuaPermissionService } from "./cua-permission-broker/cuaPermissionService.js";
import type { IBotsService } from "./bots/bots.js";
import type { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type {
  IModelSelectionService,
  IProviderSettingsService,
} from "./model-provider/providerFacadeServices.js";
import type { IRuntimePolicyService } from "./runtime-policy/runtimePolicy.js";
import type { IClientConfigService } from "./client-config/clientConfig.js";
import type { IClientScenesService } from "./client-scenes/clientScenes.js";
import type { ISkillsService } from "./skills/skills.js";
import type { ISkillSyncService } from "./skill-sync/skillSync.js";
import type { IDeviceSyncStateService, IUserConfigSyncService } from "./data-sync/index.js";
import type { IProviderProvisioningStatusService } from "./provider-provisioning-status/index.js";
import type { IPluginSyncService } from "./plugin-sync/pluginSync.js";
import type { IPluginManagementService } from "./plugins/pluginManagement.js";
import type { ISubagentsService } from "./subagents/subagents.js";
import type { ICommandsService } from "./commands/commands.js";
import type { IHooksService } from "./hooks/hooks.js";
import type { IMemoryService } from "./memory/memory.js";
import type { IOutputStyleService } from "./output-style/outputStyle.js";
import type { ISettingsSyncService } from "./settings-sync/settingsSync.js";
import type { IPromptAttachmentTransferService } from "./prompt-attachment-transfer/promptAttachmentTransfer.js";
import type { IWindowControllerService } from "./window-controller/windowController.js";
import type { ISourceServerWorkspaceService } from "./source-server-workspace/sourceServerWorkspace.js";
import type { ISourceServerManagementService } from "./source-server-management/sourceServerManagement.js";

/** UI 层消费的统一服务接口 */
export interface IServiceAccessor {
  readonly taskGroupService?: ITaskGroupService;
  readonly projectService?: IProjectService;
  readonly remoteProjectService?: IRemoteProjectService;
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
  readonly fileService: IFileService;
  readonly mediaPreviewService?: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly settingService: ISettingService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  /** 窗口 Host 聚合面；旧 server wire 或测试 double 可暂不提供。 */
  readonly windowControllerService?: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  // CUA 是 opt-in 内测特性：local macOS host 提供，远端 等 host 没有。可选避免连锁必填。
  readonly cuaPermissionService?: ICuaPermissionService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  /** 当前 Environment 的 Provider 配置与设置视图。 */
  readonly providerSettingsService: IProviderSettingsService;
  /** 当前 Environment Registry 发布的唯一模型选择 View。 */
  readonly modelSelectionService: IModelSelectionService;
  /** Registered only by source-server hosts, not direct OMP browser attachments. */
  readonly sourceServerWorkspaceService?: ISourceServerWorkspaceService;
  /** 仅桌面窗口 Host 的 base attachment 注册；远端 / Web 不提供。 */
  readonly sourceServerManagementService?: ISourceServerManagementService;
  /** 仅桌面本机 Host 注册：数据同步页的设备同步状态。 */
  readonly deviceSyncStateService?: IDeviceSyncStateService;
  /** 仅桌面本机 Host 注册：数据同步页模型提供商的 Provisioning lane 状态与重试。 */
  readonly providerProvisioningStatusService?: IProviderProvisioningStatusService;
  readonly runtimePolicyService?: IRuntimePolicyService;
  readonly clientConfigService: IClientConfigService;
  /** 普通自动化模板的可选来源；未注册时 UI 明确展示不可用，不回退到营销场景后端。 */
  readonly clientScenesService?: IClientScenesService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly genUiService?: IGenUiService;
  readonly pluginSyncService?: IPluginSyncService;
  /** 数据同步：子智能体 / 命令 / 钩子共用的用户配置同步通道（按 category 区分）。 */
  readonly userConfigSyncService: IUserConfigSyncService;
  /** Optional plugin-host capability; direct OMP browsers do not register it. */
  readonly pluginManagementService?: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly outputStyleService: IOutputStyleService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;
}

/** Registered RPC service names and their exported methods/events; no credentials or business data. */
export type ServiceCapabilityManifest = Readonly<Partial<Record<keyof IServiceAccessor, readonly string[]>>>;
