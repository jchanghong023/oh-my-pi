import { IGenUiService } from "@zcode/services";
import { ProxyChannel, type IChannelClient } from "@zcode/rpc";
import {
  IFileService,
  IMediaPreviewService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ISettingService,
  ICredentialService,
  IBroadcastService,
  IZCodeTaskService,
  IZCodeAgentService,
  IZCodeSessionService,
  IProjectService,
  ITaskGroupService,
  IRemoteProjectService,
  ICuaPermissionService,
  IBotsService,
  IFileWatcherService,
  IModelSelectionService,
  IProviderSettingsService,
  IProviderProvisioningTargetService,
  ISourceServerWorkspaceService,
  ISourceServerManagementService,
  IDeviceSyncStateService,
  IProviderProvisioningStatusService,
  IRuntimePolicyService,
  IClientConfigService,
  ISkillsService,
  ISkillSyncService,
  IUserConfigSyncService,
  IPluginSyncService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  IOutputStyleService,
  ISettingsSyncService,
  IPromptAttachmentTransferService,
  IWindowControllerService,
  IWindowProjectService,
  IWindowRemoteProjectService,
  IWindowProjectChangesService,
  type WindowProjectDirectoryServices,
  type IServiceAccessor,
} from "@zcode/services";

export interface RemoteServiceAccessOptions {
  sourceServerManagementService?: boolean;
  deviceSyncStateService?: boolean;
  windowProjectDirectory?: boolean;
  /** Direct browsers have no desktop, remote-control or native plugin host. */
  browserDirect?: boolean;
}

/**
 * RemoteServiceAccess — 通过 ChannelClient 自动创建类型安全的服务代理
 *
 * 新增服务只需在此添加一个 getter。
 */
export class RemoteServiceAccess implements IServiceAccessor {
  readonly windowProjectDirectory?: WindowProjectDirectoryServices;
  readonly fileService: IFileService;
  readonly mediaPreviewService: IMediaPreviewService;
  readonly gitService: IGitService;
  readonly gitCheckpointService: IGitCheckpointService;
  readonly systemService: ISystemService;
  readonly settingService: ISettingService;
  readonly credentialService: ICredentialService;
  readonly broadcastService: IBroadcastService;
  readonly zcodeTaskService: IZCodeTaskService;
  readonly windowControllerService?: IWindowControllerService;
  readonly zcodeAgentService: IZCodeAgentService;
  readonly zcodeSessionService: IZCodeSessionService;
  readonly taskGroupService: ITaskGroupService;
  readonly projectService: IProjectService;
  readonly remoteProjectService?: IRemoteProjectService;
  readonly cuaPermissionService?: ICuaPermissionService;
  readonly botsService: IBotsService;
  readonly fileWatcherService: IFileWatcherService;
  readonly providerSettingsService: IProviderSettingsService;
  readonly modelSelectionService: IModelSelectionService;
  /** Host-only target proxy；不属于 IServiceAccessor，避免向 Renderer 暴露 Secret 写入接口。 */
  readonly providerProvisioningTargetService?: IProviderProvisioningTargetService;
  readonly sourceServerWorkspaceService?: ISourceServerWorkspaceService;
  /** 仅 desktop base attachment 注册；其他 scope 必须按可选能力消费。 */
  readonly sourceServerManagementService?: ISourceServerManagementService;
  /** 仅 desktop base attachment 注册：数据同步页的设备同步状态。 */
  readonly deviceSyncStateService?: IDeviceSyncStateService;
  readonly providerProvisioningStatusService?: IProviderProvisioningStatusService;
  readonly runtimePolicyService?: IRuntimePolicyService;
  readonly clientConfigService: IClientConfigService;
  readonly skillsService: ISkillsService;
  readonly skillSyncService: ISkillSyncService;
  readonly genUiService?: IGenUiService;
  readonly pluginSyncService?: IPluginSyncService;
  readonly userConfigSyncService: IUserConfigSyncService;
  readonly pluginManagementService?: IPluginManagementService;
  readonly subagentsService: ISubagentsService;
  readonly commandsService: ICommandsService;
  readonly hooksService: IHooksService;
  readonly memoryService: IMemoryService;
  readonly outputStyleService: IOutputStyleService;
  readonly settingsSyncService: ISettingsSyncService;
  readonly promptAttachmentTransferService: IPromptAttachmentTransferService;

  constructor(
    channelClient: IChannelClient,
    options: RemoteServiceAccessOptions = {},
  ) {
    // 远端工作区的 project 必须保留 Source 语义；只有显式能力才创建完整窗口目录组。
    if (!options.browserDirect && options.windowProjectDirectory) {
      this.windowProjectDirectory = {
        projectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectService.channelName),
        ),
        remoteProjectService: ProxyChannel.toService(
          channelClient.getChannel(IWindowRemoteProjectService.channelName),
        ),
        changesService: ProxyChannel.toService(
          channelClient.getChannel(IWindowProjectChangesService.channelName),
        ),
      };
    }
    this.fileService = ProxyChannel.toService<IFileService>(
      channelClient.getChannel(IFileService.channelName),
    );
    // Host 已注册 media-preview channel，但遗漏 renderer proxy 时，PreviewPane
    // 会静默回退到 8 MiB 的 file.readMediaPreview，导致大 MP4 无法打开。
    this.mediaPreviewService = ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(IMediaPreviewService.channelName),
    );
    this.gitService = ProxyChannel.toService<IGitService>(
      channelClient.getChannel(IGitService.channelName),
    );
    this.gitCheckpointService = ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(IGitCheckpointService.channelName),
    );
    this.systemService = ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(ISystemService.channelName),
    );
    this.settingService = ProxyChannel.toService<ISettingService>(
      channelClient.getChannel(ISettingService.channelName),
    );
    this.credentialService = ProxyChannel.toService<ICredentialService>(
      channelClient.getChannel(ICredentialService.channelName),
    );
    this.broadcastService = ProxyChannel.toService<IBroadcastService>(
      channelClient.getChannel(IBroadcastService.channelName),
    );
    this.zcodeTaskService = ProxyChannel.toService<IZCodeTaskService>(
      channelClient.getChannel(IZCodeTaskService.channelName),
    );
    if (!options.browserDirect) {
      this.windowControllerService = ProxyChannel.toService<IWindowControllerService>(
        channelClient.getChannel(IWindowControllerService.channelName),
      );
    }
    this.zcodeAgentService = ProxyChannel.toService<IZCodeAgentService>(
      channelClient.getChannel(IZCodeAgentService.channelName),
    );
    if (!options.browserDirect) {
      this.remoteProjectService = ProxyChannel.toService<IRemoteProjectService>(
        channelClient.getChannel(IRemoteProjectService.channelName),
      );
    }
    this.taskGroupService = ProxyChannel.toService<ITaskGroupService>(
      channelClient.getChannel(ITaskGroupService.channelName),
    );
    this.projectService = ProxyChannel.toService<IProjectService>(
      channelClient.getChannel(IProjectService.channelName),
    );
    this.zcodeSessionService = ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(IZCodeSessionService.channelName),
    );
    if (!options.browserDirect) {
      this.cuaPermissionService = ProxyChannel.toService<ICuaPermissionService>(
        channelClient.getChannel(ICuaPermissionService.channelName),
      );
    }
    this.botsService = ProxyChannel.toService<IBotsService>(
      channelClient.getChannel(IBotsService.channelName),
    );
    this.fileWatcherService = ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(IFileWatcherService.channelName),
    );
    this.providerSettingsService = ProxyChannel.toService<IProviderSettingsService>(
      channelClient.getChannel(IProviderSettingsService.channelName),
    );
    this.modelSelectionService = ProxyChannel.toService<IModelSelectionService>(
      channelClient.getChannel(IModelSelectionService.channelName),
    );
    if (!options.browserDirect) {
      Object.defineProperty(this, "providerProvisioningTargetService", {
        value: ProxyChannel.toService<IProviderProvisioningTargetService>(
          channelClient.getChannel(IProviderProvisioningTargetService.channelName),
        ),
        enumerable: false,
      });
    }
    if (!options.browserDirect) {
      this.sourceServerWorkspaceService = ProxyChannel.toService<ISourceServerWorkspaceService>(
        channelClient.getChannel(ISourceServerWorkspaceService.channelName),
      );
    }
    // Bug 原因：ProxyChannel 是惰性的，无论服务端是否注册 channel 都能构造出“看似存在”
    // 的对象，optional 合同因此在首次调用时才失败。scope 创建时必须显式声明能力。
    this.sourceServerManagementService = !options.browserDirect && options.sourceServerManagementService
      ? ProxyChannel.toService<ISourceServerManagementService>(
          channelClient.getChannel(ISourceServerManagementService.channelName),
        )
      : undefined;
    this.deviceSyncStateService = !options.browserDirect && options.deviceSyncStateService
      ? ProxyChannel.toService<IDeviceSyncStateService>(
          channelClient.getChannel(IDeviceSyncStateService.channelName),
        )
      : undefined;
    // 与设备同步状态同属数据同步页的本机 Host 服务：同一开关（只在桌面 base 连接打开）。
    this.providerProvisioningStatusService = !options.browserDirect && options.deviceSyncStateService
      ? ProxyChannel.toService<IProviderProvisioningStatusService>(
          channelClient.getChannel(IProviderProvisioningStatusService.channelName),
        )
      : undefined;
    if (!options.browserDirect) {
      this.runtimePolicyService = ProxyChannel.toService<IRuntimePolicyService>(
        channelClient.getChannel(IRuntimePolicyService.channelName),
      );
    }
    this.clientConfigService = ProxyChannel.toService<IClientConfigService>(
      channelClient.getChannel(IClientConfigService.channelName),
    );
    this.skillsService = ProxyChannel.toService<ISkillsService>(
      channelClient.getChannel(ISkillsService.channelName),
    );
    this.skillSyncService = ProxyChannel.toService<ISkillSyncService>(
      channelClient.getChannel(ISkillSyncService.channelName),
    );
    if (!options.browserDirect) {
      this.genUiService = ProxyChannel.toService<IGenUiService>(
        channelClient.getChannel(IGenUiService.channelName),
      );
    }
    if (!options.browserDirect) {
      this.pluginSyncService = ProxyChannel.toService<IPluginSyncService>(
        channelClient.getChannel(IPluginSyncService.channelName),
      );
    }
    this.userConfigSyncService = ProxyChannel.toService<IUserConfigSyncService>(
      channelClient.getChannel(IUserConfigSyncService.channelName),
    );
    if (!options.browserDirect) {
      this.pluginManagementService = ProxyChannel.toService<IPluginManagementService>(
        channelClient.getChannel(IPluginManagementService.channelName),
      );
    }
    this.subagentsService = ProxyChannel.toService<ISubagentsService>(
      channelClient.getChannel(ISubagentsService.channelName),
    );
    this.commandsService = ProxyChannel.toService<ICommandsService>(
      channelClient.getChannel(ICommandsService.channelName),
    );
    this.hooksService = ProxyChannel.toService<IHooksService>(
      channelClient.getChannel(IHooksService.channelName),
    );
    this.memoryService = ProxyChannel.toService<IMemoryService>(
      channelClient.getChannel(IMemoryService.channelName),
    );
    this.outputStyleService = ProxyChannel.toService<IOutputStyleService>(
      channelClient.getChannel(IOutputStyleService.channelName),
    );
    this.settingsSyncService = ProxyChannel.toService<ISettingsSyncService>(
      channelClient.getChannel(ISettingsSyncService.channelName),
    );
    this.promptAttachmentTransferService = ProxyChannel.toService<IPromptAttachmentTransferService>(
      channelClient.getChannel(IPromptAttachmentTransferService.channelName),
    );
  }
}
