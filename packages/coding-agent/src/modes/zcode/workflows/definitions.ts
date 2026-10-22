import { constants } from "node:fs";
import { copyFile, link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import * as Protocol from "../schema/vendor/zcode-protocol/index.js";
import type { OmpWorkflowJournal } from "./journal.js";

type Meta = Protocol.ZCodeSavedWorkflowMeta;
type Scope = Protocol.ZCodeSavedWorkflowScope;
type Ref = { workspace: { workspacePath: string }; name: string; scope?: Scope };
const extension = ".dwf.ts";
const sentinel = "/* zcode-workflow";
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function code(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException)?.code;
}
function missing(error: unknown): boolean {
	return code(error) === "ENOENT" || code(error) === "ENOTDIR";
}
export function isValidSavedWorkflowName(name: string): boolean {
	return (
		name.length > 0 && name.length <= 64 && /^[A-Za-z0-9_.-]+$/u.test(name) && name.replaceAll(".", "").length > 0
	);
}
export function serializeSavedWorkflow(meta: Meta, script: string): string {
	const parsed = Protocol.zcodeSavedWorkflowMetaSchema.parse(meta);
	const body: Record<string, unknown> = { description: parsed.description };
	if (parsed.whenToUse !== undefined) body.whenToUse = parsed.whenToUse;
	if (parsed.args !== undefined) body.args = parsed.args;
	return `${sentinel}\n${stringifyYaml(body)}*/\n${script}`;
}
export function parseSavedWorkflow(
	source: string,
): { ok: true; meta: Meta; script: string; bodyLineOffset: number } | { ok: false; detail: string } {
	const lines = source.split("\n");
	let start = 0;
	while (start < lines.length && lines[start]!.trim() === "") start++;
	if (lines[start]?.trim() !== sentinel)
		return { ok: false, detail: `file does not start with the ${sentinel} metadata block` };
	let end = start + 1;
	while (end < lines.length && lines[end]!.trim() !== "*/") end++;
	if (end === lines.length) return { ok: false, detail: "metadata block is never closed with */" };
	try {
		const parsed = Protocol.zcodeSavedWorkflowMetaSchema.safeParse(parseYaml(lines.slice(start + 1, end).join("\n")));
		if (!parsed.success) return { ok: false, detail: parsed.error.message };
		return { ok: true, meta: parsed.data, script: lines.slice(end + 1).join("\n"), bodyLineOffset: end + 1 };
	} catch (error) {
		return { ok: false, detail: message(error) };
	}
}
export type WorkflowArgsValidation = { ok: true; args: Record<string, unknown> } | { ok: false; errors: string[] };
/** Same original saved-workflow argument rules; validation never changes declaration or input. */
export function validateWorkflowArgs(
	declaration: Meta["args"] | undefined,
	provided: Record<string, unknown> | undefined,
): WorkflowArgsValidation {
	const declared = declaration ?? {};
	const given = provided ?? {};
	const errors: string[] = [];
	const args: Record<string, unknown> = {};
	for (const key of Object.keys(given))
		if (!Object.hasOwn(declared, key))
			errors.push(
				Object.keys(declared).length === 0
					? `unknown argument '${key}': this workflow declares no arguments`
					: `unknown argument '${key}' (declared: ${Object.keys(declared).join(", ")})`,
			);
	for (const [key, spec] of Object.entries(declared)) {
		const supplied = Object.hasOwn(given, key) ? given[key] : undefined;
		const value = supplied === undefined ? spec.default : supplied;
		if (value === undefined) {
			if (spec.required) errors.push(`missing required argument '${key}'`);
			continue;
		}
		if (spec.type !== "json" && (typeof value !== spec.type || (spec.type === "number" && !Number.isFinite(value)))) {
			const expected = spec.type === "number" ? "a finite number" : `a ${spec.type}`;
			const actual = value === null ? "null" : Array.isArray(value) ? "an array" : `a ${typeof value}`;
			errors.push(
				`argument '${key}': expected ${expected}, got ${actual} (${supplied === undefined ? "default value" : "value"})`,
			);
		} else Object.defineProperty(args, key, { value, enumerable: true, configurable: true, writable: true });
	}
	return errors.length ? { ok: false, errors } : { ok: true, args };
}
export class WorkflowDefinitions {
	readonly #options: {
		journal: OmpWorkflowJournal;
		homeDir?: string;
		validateScript: (script: string) => { ok: boolean; detail?: string } | Promise<{ ok: boolean; detail?: string }>;
	};
	constructor(options: {
		journal: OmpWorkflowJournal;
		homeDir?: string;
		validateScript: (script: string) => { ok: boolean; detail?: string } | Promise<{ ok: boolean; detail?: string }>;
	}) {
		this.#options = options;
	}
	#dir(cwd: string, scope: Scope): string {
		return join(scope === "global" ? (this.#options.homeDir ?? homedir()) : cwd, ".zcode", "workflows");
	}
	#path(params: Ref): string {
		return join(this.#dir(params.workspace.workspacePath, params.scope ?? "project"), `${params.name}${extension}`);
	}
	async #exists(path: string): Promise<boolean> {
		try {
			await stat(path);
			return true;
		} catch (error) {
			if (missing(error)) return false;
			throw error;
		}
	}
	async get(params: Protocol.ZCodeWorkflowsGetParams | Ref): Promise<Protocol.ZCodeWorkflowsGetResult> {
		if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
		const path = this.#path(params);
		try {
			const parsed = parseSavedWorkflow(await readFile(path, "utf8"));
			if (!parsed.ok) return { ok: false, reason: "parse_error", detail: parsed.detail };
			return {
				ok: true,
				name: params.name,
				path,
				scope: params.scope ?? "project",
				meta: parsed.meta,
				script: parsed.script,
			};
		} catch (error) {
			return { ok: false, reason: missing(error) ? "not_found" : "read_error", detail: message(error) };
		}
	}
	async list(params: {
		workspace: { workspacePath: string };
		scope?: Scope;
	}): Promise<Protocol.ZCodeWorkflowsListResult> {
		const dir = this.#dir(params.workspace.workspacePath, params.scope ?? "project");
		const workflows: Protocol.ZCodeSavedWorkflowEntry[] = [];
		const invalid: Protocol.ZCodeSavedWorkflowInvalidEntry[] = [];
		let names: string[];
		try {
			names = await readdir(dir);
		} catch (error) {
			if (!missing(error)) invalid.push({ path: dir, reason: message(error) });
			return { workflows, invalid, dir };
		}
		for (const filename of names.sort()) {
			if (!filename.endsWith(extension)) continue;
			const name = filename.slice(0, -extension.length);
			const path = join(dir, filename);
			if (!isValidSavedWorkflowName(name)) {
				invalid.push({ path, reason: "file name is not a usable workflow name" });
				continue;
			}
			const result = await this.get({ ...params, name });
			if (result.ok) workflows.push({ name, path, scope: result.scope, ...result.meta });
			else invalid.push({ path, reason: result.detail ?? result.reason });
		}
		return { workflows, invalid, dir };
	}
	async #replace(path: string, source: string): Promise<void> {
		const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
		try {
			await writeFile(temporary, source, { encoding: "utf8", flag: "wx" });
			await rename(temporary, path);
		} finally {
			await unlink(temporary).catch(error => {
				if (!missing(error)) throw error;
			});
		}
	}
	async updateMeta(
		params: Protocol.ZCodeWorkflowsUpdateMetaParams | (Ref & { meta: Meta }),
	): Promise<Protocol.ZCodeWorkflowsUpdateMetaResult> {
		const meta = Protocol.zcodeSavedWorkflowMetaSchema.parse(params.meta);
		const found = await this.get(params);
		if (!found.ok) return found;
		try {
			await this.#replace(found.path, serializeSavedWorkflow(meta, found.script));
			return { ok: true, path: found.path };
		} catch (error) {
			return { ok: false, reason: "read_error", detail: message(error) };
		}
	}
	async delete(params: Protocol.ZCodeWorkflowsDeleteParams | Ref): Promise<Protocol.ZCodeWorkflowsDeleteResult> {
		if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
		const path = this.#path(params);
		try {
			await unlink(path);
			return { ok: true, path };
		} catch (error) {
			return { ok: false, reason: missing(error) ? "not_found" : "read_error", detail: message(error) };
		}
	}
	async move(params: {
		workspace: { workspacePath: string };
		name: string;
	}): Promise<Protocol.ZCodeWorkflowsMoveResult> {
		if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
		const from = this.#path({ ...params, scope: "global" });
		const to = this.#path({ ...params, scope: "project" });
		try {
			await stat(from);
		} catch (error) {
			return { ok: false, reason: missing(error) ? "not_found" : "read_error", detail: message(error), path: from };
		}
		try {
			await mkdir(dirname(to), { recursive: true });
			// A no-replace hard link is atomic on one device; exclusive copy preserves that rule across devices.
			try {
				await link(from, to);
			} catch (error) {
				if (code(error) === "EXDEV" || code(error) === "EPERM" || code(error) === "ENOTSUP")
					await copyFile(from, to, constants.COPYFILE_EXCL);
				else throw error;
			}
			await unlink(from);
			return { ok: true, from, to };
		} catch (error) {
			return {
				ok: false,
				reason: code(error) === "EEXIST" ? "target_exists" : "write_error",
				path: to,
				detail: message(error),
			};
		}
	}
	async saveFromRun(
		params: Protocol.ZCodeWorkflowsSaveParams | (Ref & { runId: string; meta: Meta; overwrite?: boolean }),
	): Promise<Protocol.ZCodeWorkflowsSaveResult> {
		if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
		const meta = Protocol.zcodeSavedWorkflowMetaSchema.parse(params.meta);
		const record = this.#options.journal.getRun(params.runId);
		if (!record || (record.cwd !== undefined && record.cwd !== params.workspace.workspacePath))
			return { ok: false, reason: "run_not_found" };
		if (record.scriptText === undefined) return { ok: false, reason: "script_missing" };
		const path = this.#path(params);
		const scope = params.scope ?? "project";
		try {
			const exists = await this.#exists(path);
			if (exists && !params.overwrite) return { ok: false, reason: "target_exists", path };
			const analysis = await this.#options.validateScript(record.scriptText);
			if (!analysis.ok) return { ok: false, reason: "compile_failed", path, detail: analysis.detail };
			const otherExists = await this.#exists(
				this.#path({ ...params, scope: scope === "project" ? "global" : "project" }),
			);
			const source = serializeSavedWorkflow(meta, record.scriptText);
			await mkdir(dirname(path), { recursive: true });
			let overwritten = false;
			try {
				await writeFile(path, source, { encoding: "utf8", flag: "wx" });
			} catch (error) {
				if (code(error) !== "EEXIST") throw error;
				if (!params.overwrite) return { ok: false, reason: "target_exists", path };
				overwritten = true;
				await this.#replace(path, source);
			}
			return {
				ok: true,
				name: params.name,
				path,
				scope,
				overwritten,
				...(otherExists
					? { shadowing: scope === "project" ? ("hides_global" as const) : ("hidden_by_project" as const) }
					: {}),
			};
		} catch (error) {
			return { ok: false, reason: "write_error", path, detail: message(error) };
		}
	}
	async forRun(params: {
		workspace: { workspacePath: string };
		runId: string;
		candidates?: { name: string; scope?: Scope }[];
	}): Promise<Protocol.ZCodeWorkflowsForRunResult> {
		const found = this.#options.journal.getRun(params.runId);
		const record = found?.cwd === undefined || found.cwd === params.workspace.workspacePath ? found : undefined;
		const runArgs = record?.args === undefined ? {} : { runArgs: record.args };
		const entry = (
			value: Extract<Protocol.ZCodeWorkflowsGetResult, { ok: true }>,
		): Protocol.ZCodeSavedWorkflowEntry => ({
			name: value.name,
			scope: value.scope,
			path: value.path,
			...value.meta,
		});
		const resolve = async (name: string, scope?: Scope) => {
			if (scope) return this.get({ workspace: params.workspace, name, scope });
			const project = await this.get({ workspace: params.workspace, name, scope: "project" });
			return project.ok || project.reason !== "not_found"
				? project
				: this.get({ workspace: params.workspace, name, scope: "global" });
		};
		for (const candidate of params.candidates ?? []) {
			const result = await resolve(candidate.name, candidate.scope);
			if (result.ok) return { entry: entry(result), match: "candidate", ...runArgs };
		}
		if (record?.scriptText !== undefined)
			for (const scope of ["project", "global"] as const) {
				const list = await this.list({ workspace: params.workspace, scope });
				for (const candidate of list.workflows) {
					const result = await resolve(candidate.name, scope);
					if (result.ok && result.script === record.scriptText)
						return { entry: entry(result), match: "script", ...runArgs };
				}
			}
		if (record?.name) {
			const result = await resolve(record.name);
			if (result.ok) return { entry: entry(result), match: "name", ...runArgs };
		}
		return runArgs;
	}
}
