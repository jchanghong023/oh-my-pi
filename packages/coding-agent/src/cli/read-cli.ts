/**
 * Read CLI command handler.
 *
 * Handles `omp read` — invokes the `read` agent tool against a path/URL and
 * prints the resulting content blocks exactly as the model would receive them
 * (including truncation/limit notices appended by the meta-notice wrapper).
 */
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { COMPANY_PROVIDER_ID, getCompanyConfigError } from "../config/company-provider";
import { ModelRegistry } from "../config/model-registry";
import { expandRoleAlias } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { initializeWithSettings } from "../discovery";
import { cfgDisasmBackend, installStatus, releaseDatabases, resolveWorkerRuntime } from "../disasm";
import { loadSkills } from "../extensibility/skills";
import { closeDaemonClient } from "../daemon/client";
import { discoverAndLoadMCPTools } from "../mcp/loader";
import { MCPManager } from "../mcp/manager";
import { discoverAuthStorage, initializeOfflineModelCommand, loadCliExtensionProviders } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import type { ToolSession } from "../tools";
import { wrapToolWithMetaNotice } from "../tools/output-meta";
import { ReadTool } from "../tools/read";
import { renderError } from "../tools/tool-errors";
import { type ResolvedImageQuestionModel, resolveImageQuestionModel } from "../utils/image-question";

import { cfgDisabledExtensions, cfgExtensions, cfgSkills } from "../extensibility/settings";
import { cfgMcpEnableProjectConfig } from "../mcp/settings";

export interface ReadCommandArgs {
	path: string;
}

/**
 * `read` may split the input into list entries (`;`, `,`, whitespace) and read each one, so the
 * caller's skills load whenever any entry could be a skill:// URL. Loading them is local and cheap.
 */
const SKILL_URL_RE = /skill:\/\//i;

export async function runReadCommand(cmd: ReadCommandArgs): Promise<void> {
	if (!cmd.path) {
		process.stderr.write(chalk.red("error: path is required\n"));
		process.exit(1);
	}

	const cwd = getProjectDir();
	const settings = await Settings.init({ cwd });
	// Capability providers (skills, MCP servers, SSH hosts) honor this session's provider switches.
	initializeWithSettings(settings);

	const session: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};

	let authStorage: AuthStorage | undefined;
	let mcpManager: MCPManager | undefined;
	let failed = false;

	try {
		if (SKILL_URL_RE.test(cmd.path)) {
			const discovered = await loadSkills({
				...cfgSkills.get(settings),
				cwd,
				disabledExtensions: cfgDisabledExtensions.get(settings),
				extensionRoots: {
					explicit: [],
					mode: "merge",
					configured: cfgExtensions.get(settings),
					configuredLevel: settings.extensionsSourceLevel(),
				},
			});
			session.skills = discovered.skills;
		}

		// MCP servers start only when a read reaches an MCP resource — `mcp://`, a scheme with no
		// registered handler, or a skill:// URL no loaded skill owns — in any list entry.
		MCPManager.setDeferredInstance(async () => {
			authStorage ??= await discoverAuthStorage(undefined, { settings });
			const result = await discoverAndLoadMCPTools(cwd, {
				enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
				filterExa: true,
				// `omp read` has no Eval prelude, so browser MCP remains available.
				filterBrowser: false,
				authStorage,
			});
			mcpManager = result.manager;
			session.mcpManager = mcpManager;
			return mcpManager;
		});

		// Ordinary file reads (including JSON selectors) need neither credentials nor a registry.
		// Initialize them only for X reads or once ReadTool routes a question to its image loader.
		let companyLane: boolean | undefined;
		const initializeModels = async (): Promise<boolean> => {
			if (companyLane !== undefined) return companyLane;
			const offline = await initializeOfflineModelCommand(settings, undefined, message => {
				process.stderr.write(`${message}\n`);
			});
			authStorage ??= await discoverAuthStorage(undefined, { settings });
			const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
			for (const warning of modelRegistry.getReservedProviderWarnings()) process.stderr.write(`${warning}\n`);
			await modelRegistry.hydrateCredentialScopedModelCaches();
			await loadCliExtensionProviders(modelRegistry, settings, cwd, { offline });
			session.modelRegistry = modelRegistry;
			return (companyLane = offline);
		};

		const resolveVisionModel = async (): Promise<ResolvedImageQuestionModel> => {
			const companyError = (await initializeModels()) ? getCompanyConfigError() : undefined;
			if (!companyError) return resolveImageQuestionModel(session);
			// A configured non-company route is an explicit choice, not a fallback.
			// Keep a broken company selection from falling through to @default.
			if (expandRoleAlias("@vision", settings).toLowerCase().startsWith(`${COMPANY_PROVIDER_ID}/`)) {
				throw new Error(companyError);
			}
			let resolved: ResolvedImageQuestionModel;
			try {
				resolved = resolveImageQuestionModel(session);
			} catch {
				throw new Error(companyError);
			}
			const role = resolved.selectedPattern === "@vision" ? "vision" : "default";
			if (
				!resolved.selectedPattern ||
				!settings.getModelRole(role) ||
				resolved.model.provider === COMPANY_PROVIDER_ID
			) {
				throw new Error(companyError);
			}
			return resolved;
		};

		const tool = wrapToolWithMetaNotice(new ReadTool(session, undefined, resolveVisionModel, initializeModels));
		const result = await tool.execute("omp-read", { path: cmd.path });

		for (const block of result.content) {
			if (block.type === "text") {
				process.stdout.write(block.text);
				if (!block.text.endsWith("\n")) process.stdout.write("\n");
			} else if (block.type === "image") {
				const decodedBytes = Buffer.from(block.data, "base64").byteLength;
				process.stdout.write(
					chalk.dim(`[image content: ${block.mimeType}, ${decodedBytes} bytes base64-decoded]\n`),
				);
			}
		}
	} catch (err) {
		process.stderr.write(`${chalk.red(renderError(err))}\n`);
		failed = true;
		const backend = cfgDisasmBackend.get(settings);
		if (backend !== undefined && installStatus(backend) !== undefined) {
			// The caller's deadline must not terminate a shared download or release its install lock mid-build.
			try {
				await resolveWorkerRuntime(session, backend);
			} catch (error) {
				process.stderr.write(`${chalk.red(renderError(error))}\n`);
			}
		}
	} finally {
		MCPManager.setDeferredInstance(undefined);
		if (mcpManager) {
			await mcpManager.disconnectAll();
			if (MCPManager.instance() === mcpManager) MCPManager.setInstance(undefined);
		}
		authStorage?.close();
		// Save backend changes and drop host sockets that would keep the event loop alive.
		await releaseDatabases();
		await closeDaemonClient();
	}

	if (failed) process.exit(1);
}
