/**
 * Sync Claude Code's Anthropic endpoint and token into the active OMP profile's models config.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { JSONC, YAML } from "bun";
import { ModelsConfigFile } from "../config/models-config";
import type { ModelsConfig } from "../config/models-config-schema";
import { replaceFileAtomically } from "../utils/atomic-file";

const DESCRIPTION = "Sync Claude Code ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN into the active profile's models.yml";

interface ClaudeAnthropicValues {
	baseUrl: string;
	apiKey: string;
}

interface SingleMappingLine {
	key: string;
	value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function claudeSettingsPath(): string {
	return path.join(os.homedir(), ".claude", "settings.json");
}

async function readClaudeAnthropicValues(): Promise<ClaudeAnthropicValues> {
	const settingsPath = claudeSettingsPath();
	let source: string;
	try {
		source = await fs.readFile(settingsPath, "utf8");
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Claude Code settings not found: ${settingsPath}`);
		throw new Error(`Failed to read Claude Code settings: ${settingsPath}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSONC.parse(source);
	} catch (error) {
		throw new Error(`Failed to parse Claude Code settings: ${settingsPath}`, { cause: error });
	}
	if (!isRecord(parsed) || !isRecord(parsed.env)) {
		throw new Error(`Claude Code settings has no env object: ${settingsPath}`);
	}

	const baseUrl = parsed.env.ANTHROPIC_BASE_URL;
	const apiKey = parsed.env.ANTHROPIC_AUTH_TOKEN;
	if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
		throw new Error(`Claude Code settings env.ANTHROPIC_BASE_URL is missing or empty: ${settingsPath}`);
	}
	if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
		throw new Error(`Claude Code settings env.ANTHROPIC_AUTH_TOKEN is missing or empty: ${settingsPath}`);
	}

	return { baseUrl: baseUrl.trim(), apiKey: apiKey.trim() };
}

function providerUsesAnthropicMessages(provider: NonNullable<ModelsConfig["providers"]>[string]): boolean {
	if (provider.api === "anthropic-messages") return true;
	return (provider.models ?? []).some(model => model.api === "anthropic-messages");
}

function selectProvider(config: ModelsConfig, explicitProvider: string | undefined): string {
	const providers = config.providers ?? {};
	const names = Object.keys(providers);
	if (explicitProvider) {
		if (!(explicitProvider in providers)) {
			const configured = names.length > 0 ? ` Configured providers: ${names.sort().join(", ")}.` : "";
			throw new Error(`Provider "${explicitProvider}" does not exist in models config.${configured}`);
		}
		return explicitProvider;
	}

	const candidates = names.filter(name => providerUsesAnthropicMessages(providers[name]));
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0) {
		const configured = names.length > 0 ? ` Configured providers: ${names.sort().join(", ")}.` : "";
		throw new Error(
			`No Anthropic-compatible provider could be selected automatically. Use --provider <id>.${configured}`,
		);
	}
	throw new Error(
		`Multiple Anthropic-compatible providers found: ${candidates.sort().join(", ")}. Use --provider <id>.`,
	);
}

function leadingSpaces(line: string): number {
	let index = 0;
	while (index < line.length && line.charCodeAt(index) === 32) index += 1;
	return index;
}

function isBlankOrComment(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length === 0 || trimmed.startsWith("#");
}

function parseSingleMappingLine(line: string): SingleMappingLine | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) return undefined;
	try {
		const parsed = YAML.parse(trimmed);
		if (!isRecord(parsed)) return undefined;
		const keys = Object.keys(parsed);
		if (keys.length !== 1) return undefined;
		const key = keys[0];
		return { key, value: parsed[key] };
	} catch {
		return undefined;
	}
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function updateProviderValues(source: string, providerName: string, values: ClaudeAnthropicValues): string {
	const newline = source.includes("\r\n") ? "\r\n" : "\n";
	const lines = source.split(/\r?\n/);

	let providersLine = -1;
	let providersIndent = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const parsed = parseSingleMappingLine(lines[index]);
		if (parsed?.key === "providers" && parsed.value === null) {
			providersLine = index;
			providersIndent = leadingSpaces(lines[index]);
			break;
		}
	}
	if (providersLine < 0) throw new Error('models config must contain a block-style "providers:" mapping');

	let providerIndent: number | undefined;
	for (let index = providersLine + 1; index < lines.length; index += 1) {
		if (isBlankOrComment(lines[index])) continue;
		const indent = leadingSpaces(lines[index]);
		if (indent <= providersIndent) break;
		providerIndent = indent;
		break;
	}
	if (providerIndent === undefined) throw new Error("models config providers mapping is empty");

	let providerLine = -1;
	for (let index = providersLine + 1; index < lines.length; index += 1) {
		if (isBlankOrComment(lines[index])) continue;
		const indent = leadingSpaces(lines[index]);
		if (indent <= providersIndent) break;
		if (indent !== providerIndent) continue;
		const parsed = parseSingleMappingLine(lines[index]);
		if (parsed?.key !== providerName) continue;
		if (parsed.value !== null) {
			throw new Error(`Provider "${providerName}" must use block-style YAML to sync Claude settings`);
		}
		providerLine = index;
		break;
	}
	if (providerLine < 0) throw new Error(`Could not locate provider "${providerName}" in models config text`);

	let providerEnd = lines.length;
	for (let index = providerLine + 1; index < lines.length; index += 1) {
		if (isBlankOrComment(lines[index])) continue;
		if (leadingSpaces(lines[index]) <= providerIndent) {
			providerEnd = index;
			break;
		}
	}

	let childIndent: number | undefined;
	for (let index = providerLine + 1; index < providerEnd; index += 1) {
		if (isBlankOrComment(lines[index])) continue;
		const indent = leadingSpaces(lines[index]);
		if (indent <= providerIndent) continue;
		childIndent = childIndent === undefined ? indent : Math.min(childIndent, indent);
	}
	childIndent ??= providerIndent + 2;

	const block = lines.slice(providerLine + 1, providerEnd);
	const fieldIndexes = new Map<"baseUrl" | "apiKey", number[]>();
	fieldIndexes.set("baseUrl", []);
	fieldIndexes.set("apiKey", []);
	for (let index = 0; index < block.length; index += 1) {
		const line = block[index];
		if (isBlankOrComment(line) || leadingSpaces(line) !== childIndent) continue;
		const parsed = parseSingleMappingLine(line);
		if (parsed?.key !== "baseUrl" && parsed?.key !== "apiKey") continue;
		fieldIndexes.get(parsed.key)?.push(index);
	}

	for (const field of ["baseUrl", "apiKey"] as const) {
		const indexes = fieldIndexes.get(field) ?? [];
		if (indexes.length > 1) throw new Error(`Provider "${providerName}" contains duplicate ${field} fields`);
		if (indexes.length === 1) {
			const current = block[indexes[0]].slice(childIndent);
			const colon = current.indexOf(":");
			const valuePart = colon >= 0 ? current.slice(colon + 1).trimStart() : "";
			if (valuePart.startsWith("|") || valuePart.startsWith(">")) {
				throw new Error(`Provider "${providerName}" uses a block scalar for ${field}; use a single-line value`);
			}
		}
	}

	const baseUrlLine = `${" ".repeat(childIndent)}baseUrl: ${yamlString(values.baseUrl)}`;
	const apiKeyLine = `${" ".repeat(childIndent)}apiKey: ${yamlString(values.apiKey)}`;
	const baseUrlIndexes = fieldIndexes.get("baseUrl") ?? [];
	const apiKeyIndexes = fieldIndexes.get("apiKey") ?? [];
	if (baseUrlIndexes.length === 1) block[baseUrlIndexes[0]] = baseUrlLine;
	if (apiKeyIndexes.length === 1) block[apiKeyIndexes[0]] = apiKeyLine;

	const missing: string[] = [];
	if (baseUrlIndexes.length === 0) missing.push(baseUrlLine);
	if (apiKeyIndexes.length === 0) missing.push(apiKeyLine);
	if (missing.length > 0) block.unshift(...missing);

	lines.splice(providerLine + 1, providerEnd - providerLine - 1, ...block);
	return lines.join(newline);
}

async function validateAndReplaceModelsConfig(configPath: string, content: string): Promise<void> {
	const mode = (await fs.stat(configPath)).mode;
	const tempPath = path.join(
		path.dirname(configPath),
		`.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp.yml`,
	);
	try {
		await fs.writeFile(tempPath, content, { encoding: "utf8", mode });
		const staged = ModelsConfigFile.relocate(tempPath).tryLoad();
		if (staged.status !== "ok") {
			throw staged.status === "error" ? staged.error : new Error("Staged models config could not be loaded");
		}
		await replaceFileAtomically(tempPath, configPath);
	} finally {
		await fs.rm(tempPath, { force: true });
	}
}

async function syncClaude(
	providerFlag: string | undefined,
): Promise<{ provider: string; configPath: string; changed: boolean }> {
	const values = await readClaudeAnthropicValues();
	const modelsConfig = ModelsConfigFile.relocate(path.join(getAgentDir(), "models.yml"));
	const loaded = modelsConfig.tryLoad();
	if (loaded.status === "not-found") {
		throw new Error(`OMP models config not found under active agent directory: ${getAgentDir()}`);
	}
	if (loaded.status === "error") throw loaded.error;

	const provider = selectProvider(loaded.value, providerFlag?.trim() || undefined);
	const configPath = modelsConfig.path();
	const source = await fs.readFile(configPath, "utf8");
	const updated = updateProviderValues(source, provider, values);
	if (updated === source) return { provider, configPath, changed: false };

	await validateAndReplaceModelsConfig(configPath, updated);
	modelsConfig.invalidate();
	return { provider, configPath, changed: true };
}

export default class SyncClaude extends Command {
	static description = DESCRIPTION;
	static flags = {
		provider: Flags.string({
			description: "Provider id to update when models.yml contains multiple Anthropic-compatible providers",
		}),
	};
	static examples = ["omp sync-claude", "omp --profile work sync-claude", "omp sync-claude --provider my-anthropic"];

	async run(): Promise<void> {
		const { flags } = await this.parse(SyncClaude);
		try {
			const result = await syncClaude(flags.provider);
			const action = result.changed ? "Synced" : "Already synced";
			process.stdout.write(
				`${action} Claude Code Anthropic settings to provider "${result.provider}" in ${result.configPath}\n`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`Error: ${message}\n`);
			process.exitCode = 1;
		}
	}
}
