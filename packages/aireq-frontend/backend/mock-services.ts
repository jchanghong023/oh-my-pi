import { createPrototypeProjectServices } from "../packages/ui/src/aireq/mock/free-chats.js";
import type { IServiceAccessor, BroadcastMessage } from "@zcode/services";
import type { Hook, Memory, OutputStyle } from "@zcode/shared";
import type { PromptAttachmentTransferProgress as TransferProgress } from "../packages/services/src/prompt-attachment-transfer/promptAttachmentTransfer.js";
import { createPrototypeChatServices, type PrototypeAttachment } from "../packages/ui/src/aireq/mock/chat.js";
import { createPrototypeFileServices } from "../packages/ui/src/aireq/mock/files.js";
import { createPrototypeSettingsServices } from "../packages/ui/src/aireq/mock/settings.js";
import { readPrototypeSkills } from "../packages/ui/src/aireq/mock/skills.js";
import { createPrototypeEvent, unavailablePrototypeOperation } from "../packages/ui/src/aireq/mock/events.js";

export const PROTOTYPE_WORKSPACE = "/demo/aurora-console";
export const PROTOTYPE_WORKSPACE_IDENTITY = "aireq-ui-prototype";
export const PROTOTYPE_TASK_ID = "demo-requirements";

/** Shared in-memory services for one backend lifecycle; no external execution or resources. */
export function createPrototypeServices(): IServiceAccessor {
	const broadcast = createPrototypeEvent<BroadcastMessage>();
	const credentials = new Map<string, string>();
	const claims = new Map<string, { token: string; committed: boolean }>();
	const memories = new Map<string, Memory>();
	const attachments = new Map<string, PrototypeAttachment>();
	const sessionWorkspaces = new Map<string, string>();
	const transfers = new Map<
		string,
		{
			event: (listener: (progress: TransferProgress) => void) => { dispose(): void };
			fire(progress: TransferProgress): void;
		}
	>();
	let hooks: Hook[] = [];
	let styles: OutputStyle[] = [
		{
			id: "prototype-concise",
			name: "简洁中文（样例）",
			description: "阶段性原型展示配置，未注入任何模型",
			content: "简明展示需求边界和下一步。",
			isBuiltIn: true,
			enabled: true,
		},
	];
	let activeStyle: string | null = "prototype-concise";
	let handled = true;
	const unavailable = unavailablePrototypeOperation;
	const transfer = (id: string) => {
		const existing = transfers.get(id);
		if (existing) return existing;
		const value = createPrototypeEvent<TransferProgress>();
		transfers.set(id, value);
		return value;
	};
	const fileServices = createPrototypeFileServices();
	return {
		...fileServices,
		...createPrototypeProjectServices(),
		...createPrototypeSettingsServices(sessionWorkspaces),
		...createPrototypeChatServices(attachments, sessionWorkspaces),
		systemService: {
			info: async () => ({ homedir: "/demo/user", platform: "browser-prototype" }),
			probeIntranet: unavailable,
		},
		credentialService: {
			load: async key => credentials.get(key) ?? null,
			save: async (key, value) => {
				credentials.set(key, value);
			},
			delete: async key => {
				credentials.delete(key);
			},
		},
		broadcastService: {
			onMessage: broadcast.event,
			send: async message => {
				broadcast.fire(message);
			},
			acquireClaim: async key => {
				const existing = claims.get(key);
				if (existing?.committed) return { status: "committed" };
				if (existing) return { status: "busy", retryAfterMs: 100 };
				const token = crypto.randomUUID();
				claims.set(key, { token, committed: false });
				return { status: "acquired", lease: { key, token } };
			},
			commitClaim: async lease => {
				const claim = claims.get(lease.key);
				if (claim?.token === lease.token) claim.committed = true;
			},
			releaseClaim: async lease => {
				const claim = claims.get(lease.key);
				if (claim?.token === lease.token && !claim.committed) claims.delete(lease.key);
			},
			tryClaim: async key => {
				if (claims.has(key)) return false;
				claims.set(key, { token: crypto.randomUUID(), committed: true });
				return true;
			},
		},
		botsService: {
			syncAppRuntimePreferences: async () => {},
			getStatus: async () => ({ botsCount: 0, enabledBotsCount: 0, contextsCount: 0, botRuntime: [] }),
			getConfig: async () => ({ version: 3, bots: [] }),
			listWorkspaceRefs: async () => [],
			getUserConfigOptions: async () => [],
			getBotStates: async () => [],
			resetBotState: async () => {},
			watchAutomationRun: unavailable,
			handleInboundMessage: unavailable,
			handleProviderCallback: unavailable,
			handleProviderCallbackResponse: unavailable,
		},
		clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: null, zsrcUrl: null }) },
		skillsService: {
			list: async params => ({
				skills: readPrototypeSkills(params.workspacePath),
				capability: { userScopeAvailable: true },
				diagnostics: [],
			}),
			setEnabled: unavailable,
			buildPromptContext: async params => ({ prompt: params.prompt, activatedSkillNames: [] }),
			copyToCommon: unavailable,
			removeFromCommon: unavailable,
			deleteSkill: unavailable,
		},
		skillSyncService: {
			listSyncItems: async () => ({ items: [], homeDir: "/demo/user" }),
			getSyncContentHashes: async () => ({ hashes: {} }),
			checkSyncWriteAccess: async () => ({ ok: false, path: "/demo/user", error: "阶段性原型没有远程同步目标" }),
			exportSyncItems: async () => ({ archive: new Uint8Array(), sourceHomeDir: "/demo/user", items: [] }),
			importSyncItems: unavailable,
		},
		userConfigSyncService: {
			listSyncItems: async () => ({ items: [], homeDir: "/demo/user" }),
			getSyncContentHashes: async () => ({ hashes: {} }),
			checkSyncWriteAccess: async () => ({ ok: false, path: "/demo/user", error: "阶段性原型没有远程同步目标" }),
			exportSyncItems: unavailable,
			importSyncItems: unavailable,
		},
		subagentsService: {
			list: async () => ({
				agents: [],
				userAgents: [],
				pluginAgents: [],
				capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
			}),
			setEnabled: unavailable,
			setBuiltInModelOverride: unavailable,
			setPluginAgentModelOverride: unavailable,
			getPrimaryUserAgentsDirectory: async () => ({ path: "/demo/user/.zcode/agents" }),
			createAgent: unavailable,
			updateAgent: unavailable,
			deleteAgent: unavailable,
		},
		commandsService: {
			list: async () => ({
				commands: [],
				userCommands: [],
				pluginCommands: [],
				capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
			}),
			writeCommandFile: unavailable,
			updateCommandFile: unavailable,
			deleteCommandFile: unavailable,
			setCommandEnabled: unavailable,
			getPrimaryUserCommandsDirectory: async () => ({ path: "/demo/user/.zcode/commands" }),
		},
		hooksService: {
			loadHooks: async () => ({ hooks: structuredClone(hooks), hooksEnabled: false }),
			saveHooks: async params => {
				hooks = structuredClone(params.hooks);
			},
		},
		memoryService: {
			loadMemory: async params => ({ memory: memories.get(`${params.workspacePath}:${params.agentId}`) ?? null }),
			saveMemory: async params => {
				memories.set(`${params.workspacePath}:${params.agentId}`, {
					content: params.config.content,
					enabled: params.config.enabled ?? true,
				});
			},
			clearMemory: async params => {
				memories.delete(`${params.workspacePath}:${params.agentId}`);
			},
			getUserMemoryDirectory: async () => ({ path: "/demo/user/.zcode/memory" }),
			listProjectMemories: async () => [],
			readProjectMemoryFile: unavailable,
		},
		outputStyleService: {
			listStyles: async () => ({ styles: structuredClone(styles) }),
			addStyle: async params => {
				styles.push({
					...params.config,
					id: `prototype-style-${styles.length + 1}`,
					enabled: params.config.enabled ?? true,
					isBuiltIn: false,
				});
			},
			updateStyle: async params => {
				styles = styles.map(style => (style.id === params.id ? { ...style, ...params.config } : style));
			},
			deleteStyle: async params => {
				styles = styles.filter(style => style.id !== params.id);
			},
			getUserStylesDirectory: async () => ({ path: "/demo/user/.zcode/output-styles" }),
			setActiveStyle: async params => {
				activeStyle = params.styleId;
			},
			getActiveStyle: async () => ({ styleId: activeStyle }),
		},
		settingsSyncService: {
			getClaudeAgentsFileMigrationStatus: async () => ({
				sourcePath: "/demo/user/.claude/CLAUDE.md",
				targetPath: "/demo/user/.zcode/AGENTS.md",
				sourceExists: false,
				targetExists: false,
				supported: false,
				unavailableReason: "missingSource",
			}),
			copyClaudeAgentsFileToZcodeAgentsFile: async () => ({
				sourcePath: "/demo/user/.claude/CLAUDE.md",
				targetPath: "/demo/user/.zcode/AGENTS.md",
				status: "skipped",
				overwritten: false,
				skippedReason: "missingSource",
			}),
			detect: async () => ({ agents: [] }),
			importSelected: unavailable,
			getFirstRunPromptState: async () => ({ handled }),
			markFirstRunPromptHandled: async () => {
				handled = true;
			},
		},
		promptAttachmentTransferService: {
			stage: async params => {
				const bytesBase64 =
					params.bytesBase64 ??
					(await fileServices.fileService.readBinaryPreview({ path: params.localPath })).dataBase64;
				const bytes = atob(bytesBase64).length;
				const ref = `prototype-memory:${params.sessionId}:${params.operationId}`;
				attachments.set(params.operationId, {
					ref,
					bytes,
					adopted: false,
					sessionId: params.sessionId,
					fileName: params.fileName,
					mime: params.mime,
					bytesBase64,
				});
				transfer(params.operationId).fire({
					operationId: params.operationId,
					phase: "complete",
					uploadedBytes: bytes,
					totalBytes: bytes,
				});
				return { operationId: params.operationId, ref, bytes, staged: true };
			},
			adopt: async id => {
				const value = attachments.get(id);
				if (value) value.adopted = true;
			},
			cancel: async id => {
				const value = attachments.get(id);
				attachments.delete(id);
				transfer(id).fire({ operationId: id, phase: "canceled", uploadedBytes: 0, totalBytes: value?.bytes ?? 0 });
			},
			cleanup: async id => {
				if (!attachments.get(id)?.adopted) attachments.delete(id);
				transfers.delete(id);
			},
			onDynamicProgress: id => transfer(id).event,
		},
	};
}
