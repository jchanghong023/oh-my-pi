import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FileType, glob, grep } from "@oh-my-pi/pi-natives";
import { z } from "zod";
import { ExtensionToolWrapper } from "../../../extensibility/extensions/wrapper";
import { applyToolProxy } from "../../../extensibility/tool-proxy";
import type { Tool } from "../../../tools";
import { execCommand } from "../../../exec/exec";
import type { ZCodeSessionRecord } from "../sessions";
import {
	ARTIFACT_CAPS,
	ARTIFACT_ID_PATTERN,
	WORLD_READ_CAPS,
	WorkflowError,
	type ArtifactPublishRequest,
	type ArtifactVersionRecord,
	type WorldReadOp,
} from "./vendor/dynamic-workflow/index.js";

/** Native filesystem/process/artifact owners; never invokes another Agent or internal RPC. */
export function createOmpWorkflowWorld(parent: ZCodeSessionRecord, signal?: AbortSignal) {
	const cwd = parent.cwd;
	const nativeParams = z.record(z.string(), z.unknown());
	async function admitted<T>(
		name: string,
		params: Record<string, unknown>,
		effect: (effective: Record<string, unknown>) => Promise<T>,
	): Promise<T> {
		signal?.throwIfAborted();
		parent.toolRestrictions.assertAllowed(name);
		const native = parent.session.getToolByName(name);
		const runner = parent.session.extensionRunner;
		if (!native || !runner) throw new WorkflowError("DriverError", `Native workflow tool is unavailable: ${name}`);
		const outcome: { result?: { value: T } } = {};
		const operation: Tool = {
			name: native.name,
			label: native.label,
			description: native.description,
			parameters: native.parameters,
			execute: async (_id, effective) => {
				signal?.throwIfAborted();
				parent.toolRestrictions.assertAllowed(name);
				const value = await effect(nativeParams.parse(effective));
				outcome.result = { value };
				return { content: [], details: { value } };
			},
		};
		applyToolProxy(native, operation);
		await parent.run(() =>
			new ExtensionToolWrapper(operation, runner).execute(
				`workflow-${crypto.randomUUID()}`,
				params,
				signal,
				undefined,
				parent.creationResult.getToolContext(),
			),
		);
		if (!outcome.result) throw new WorkflowError("DriverError", "Native workflow operation returned no value");
		return outcome.result.value;
	}
	async function run(
		command: string,
		argv: string[],
		timeout: number = WORLD_READ_CAPS.runDefaultTimeoutMs,
		stdoutCap: number = WORLD_READ_CAPS.runStdoutMaxBytes,
	) {
		signal?.throwIfAborted();
		const params = {
			command: [command, ...argv].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(" "),
			cwd,
			timeout: timeout / 1000,
		};
		const result = await admitted("bash", params, effective => {
			// A shell command rewrite cannot preserve the argv-only world.run contract.
			if (!Bun.deepEquals(effective, params)) throw argumentError("rewritten world.run command");
			return execCommand(command, argv, cwd, { signal, timeout });
		});
		if (result.killed) throw new WorkflowError("DriverError", `Workflow command cancelled or timed out: ${command}`);
		if (
			Buffer.byteLength(result.stdout) > stdoutCap ||
			Buffer.byteLength(result.stderr) > WORLD_READ_CAPS.runStderrMaxBytes
		) {
			throw new WorkflowError(
				"WorldReadCapExceeded",
				`Workflow command output exceeds the world-read cap: ${command}`,
			);
		}
		return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
	}
	async function git(argv: readonly string[]) {
		const result = await run("git", [...argv], WORLD_READ_CAPS.runDefaultTimeoutMs, WORLD_READ_CAPS.gitDiffMaxBytes);
		if (result.exitCode !== 0)
			throw new WorkflowError("DriverError", `git failed: ${result.stderr || result.stdout}`);
		return result.stdout;
	}
	const world = {
		async read(op: WorldReadOp, args: unknown[]): Promise<unknown> {
			signal?.throwIfAborted();
			switch (op) {
				case "read": {
					const [given] = stringArgs(op, args, 1, 1);
					const target = await workspaceFile(cwd, given!);
					return fs.readFile(target, { encoding: "utf8", signal });
				}
				case "glob": {
					const [pattern] = stringArgs(op, args, 1, 1);
					const result = await glob({
						pattern: pattern!,
						path: cwd,
						fileType: FileType.File,
						maxResults: WORLD_READ_CAPS.globMaxFiles + 1,
						hidden: true,
						gitignore: true,
						strictErrors: true,
						signal,
					});
					if (result.matches.length > WORLD_READ_CAPS.globMaxFiles)
						throw capError("files.glob has too many matching files");
					return result.matches.map(match => match.path.replace(/\\/g, "/")).sort();
				}
				case "grep": {
					const [pattern, filter] = stringArgs(op, args, 1, 2);
					const result = await grep({
						pattern: pattern!,
						path: cwd,
						...(filter === undefined ? {} : { glob: filter }),
						maxCount: WORLD_READ_CAPS.grepMaxMatches + 1,
						maxColumns: 0,
						signal,
					});
					if (
						result.limitReached ||
						result.matches.length > WORLD_READ_CAPS.grepMaxMatches ||
						result.matches.some(match => match.truncated)
					) {
						throw capError("files.grep exceeds its complete-result cap; narrow the pattern");
					}
					const matches = result.matches.map(match => ({
						path: match.path.replace(/\\/g, "/"),
						line: match.lineNumber,
						text: match.line,
					}));
					if (Buffer.byteLength(JSON.stringify(matches)) > WORLD_READ_CAPS.grepMaxSerializedBytes)
						throw capError("files.grep exceeds its byte cap");
					return matches;
				}
				case "run": {
					if (args.length < 1 || args.length > 3 || typeof args[0] !== "string" || !args[0])
						throw argumentError(op);
					const argv = args[1] ?? [];
					if (!Array.isArray(argv) || !argv.every(arg => typeof arg === "string")) throw argumentError(op);
					const opts = args[2];
					if (opts !== undefined && (typeof opts !== "object" || opts === null || Array.isArray(opts)))
						throw argumentError(op);
					const timeout = opts && "timeoutMs" in opts ? opts.timeoutMs : WORLD_READ_CAPS.runDefaultTimeoutMs;
					if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1)
						throw argumentError(op);
					return run(args[0], argv, timeout);
				}
				case "git-changed-files": {
					const [base] = stringArgs(op, args, 0, 1);
					const plans = gitChangedFilesPlan(base);
					const prefix = parseGitShowPrefix(await git(GIT_SHOW_PREFIX_ARGV));
					const files: string[] = [];
					for (const plan of plans) files.push(...parseGitPathList(await git(plan.argv), prefix));
					return [...new Set(files)].sort();
				}
				case "git-diff": {
					const [base, given] = stringArgs(op, args, 0, 2);
					const text = await git(gitDiffArgv(base, given));
					if (Buffer.byteLength(text) > WORLD_READ_CAPS.gitDiffMaxBytes)
						throw capError("git.diff exceeds its byte cap");
					return text;
				}
				case "git-status": {
					stringArgs(op, args, 0, 0);
					const prefix = parseGitShowPrefix(await git(GIT_SHOW_PREFIX_ARGV));
					return parseGitStatusPorcelainV2(await git(GIT_STATUS_ARGV), prefix);
				}
				case "git-log": {
					const count = args[0] ?? WORLD_READ_CAPS.gitLogDefaultCount;
					if (
						args.length > 1 ||
						typeof count !== "number" ||
						!Number.isInteger(count) ||
						count < 1 ||
						count > WORLD_READ_CAPS.gitLogMaxCount
					)
						throw argumentError(op);
					return parseGitLog(await git(gitLogArgv(count)));
				}
			}
		},
		async publish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
			signal?.throwIfAborted();
			if (request.id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(request.id))
				throw argumentError("artifact id");
			const opts = request.opts;
			if (opts !== undefined && (typeof opts !== "object" || opts === null || Array.isArray(opts)))
				throw argumentError("artifact options");
			const title = opts && "title" in opts ? opts.title : undefined;
			const description = opts && "description" in opts ? opts.description : undefined;
			const mime = opts && "contentType" in opts ? opts.contentType : undefined;
			if (title !== undefined && (typeof title !== "string" || title.length > ARTIFACT_CAPS.maxTitleLength))
				throw argumentError("artifact title");
			if (
				description !== undefined &&
				(typeof description !== "string" || description.length > ARTIFACT_CAPS.maxDescriptionLength)
			)
				throw argumentError("artifact description");
			if (mime !== undefined && (typeof mime !== "string" || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mime)))
				throw argumentError("artifact MIME");
			let bytes: Buffer;
			let sourcePath: string | undefined;
			let contentType: string;
			if (request.op === "markdown") {
				if (typeof request.content !== "string") throw argumentError("artifact markdown");
				bytes = Buffer.from(request.content);
				if (bytes.length > ARTIFACT_CAPS.maxMarkdownBytes)
					throw new WorkflowError("ArtifactTooLarge", "Markdown artifact exceeds its byte cap");
				contentType = "text/markdown";
			} else {
				if (typeof request.path !== "string") throw argumentError("artifact file");
				const source = await admitted("read", { path: request.path }, async effective => {
					const given = z.string().parse(effective.path);
					let target: string;
					try {
						target = await workspaceFile(cwd, given, true);
					} catch (error) {
						if (error instanceof WorkflowError) throw error;
						throw new WorkflowError("ArtifactSourceMissing", `Artifact source is unavailable: ${given}`);
					}
					const file = await fs.open(target, "r");
					try {
						const stat = await file.stat();
						if (!stat.isFile())
							throw new WorkflowError("ArtifactSourceMissing", "Artifact source is not a regular file");
						if (stat.size > ARTIFACT_CAPS.maxFileBytes)
							throw new WorkflowError("ArtifactTooLarge", "File artifact exceeds its byte cap");
						const buffer = Buffer.alloc(Math.min(stat.size + 1, ARTIFACT_CAPS.maxFileBytes + 1));
						let offset = 0;
						while (offset < buffer.length) {
							signal?.throwIfAborted();
							const read = await file.read(buffer, offset, buffer.length - offset, offset);
							if (!read.bytesRead) break;
							offset += read.bytesRead;
						}
						if (offset > stat.size)
							throw new WorkflowError("DriverError", "Artifact source changed while reading");
						return { bytes: buffer.subarray(0, offset), target };
					} finally {
						await file.close();
					}
				});
				bytes = source.bytes;
				sourcePath = path.relative(cwd, source.target).replace(/\\/g, "/");
				contentType =
					typeof mime === "string"
						? mime
						: (MIME_BY_EXTENSION[path.extname(source.target).toLowerCase()] ?? "application/octet-stream");
			}
			signal?.throwIfAborted();
			const manager = parent.session.sessionManager;
			await manager.ensureOnDisk();
			const artifact = await manager.allocateArtifactPath(
				`workflow-${request.op === "markdown" ? "md" : path.extname(request.path!).slice(1) || "bin"}`,
			);
			if (!artifact.id || !artifact.path)
				throw new WorkflowError("ArtifactStoreUnavailable", "Native session artifact store is unavailable");
			await fs.writeFile(artifact.path, bytes, { flag: "wx", signal });
			return {
				id: request.id,
				kind: request.op,
				version: request.version,
				...(typeof title === "string" ? { title } : {}),
				...(typeof description === "string" ? { description } : {}),
				contentType,
				bytes: bytes.length,
				uri: `artifact://${artifact.id}`,
				...(sourcePath === undefined ? {} : { sourcePath }),
				publishedAt: Date.now(),
			};
		},
	};
	return {
		async read(op: WorldReadOp, args: unknown[]): Promise<unknown> {
			if (op === "read") {
				const [given] = stringArgs(op, args, 1, 1);
				return admitted("read", { path: given }, effective => world.read(op, [z.string().parse(effective.path)]));
			}
			if (op === "glob") {
				const [pattern] = stringArgs(op, args, 1, 1);
				const given = path.resolve(cwd, pattern!);
				return admitted(
					"glob",
					{ path: given, hidden: true, gitignore: true, limit: WORLD_READ_CAPS.globMaxFiles + 1 },
					effective => {
						if (
							!Bun.deepEquals(
								{ ...effective, path: given },
								{ path: given, hidden: true, gitignore: true, limit: WORLD_READ_CAPS.globMaxFiles + 1 },
							)
						) {
							throw argumentError("rewritten files.glob options");
						}
						return world.read(op, [path.relative(cwd, z.string().parse(effective.path))]);
					},
				);
			}
			if (op === "grep") {
				const [pattern, filter] = stringArgs(op, args, 1, 2);
				const params = { pattern, path: filter === undefined ? cwd : path.resolve(cwd, filter) };
				return admitted("grep", params, effective => {
					if (!Bun.deepEquals({ ...effective, pattern, path: params.path }, params))
						throw argumentError("rewritten files.grep options");
					const target = z.string().parse(effective.path);
					return world.read(op, [
						z.string().parse(effective.pattern),
						...(target === cwd ? [] : [path.relative(cwd, target)]),
					]);
				});
			}
			return world.read(op, args);
		},
		publish: world.publish,
	};
}

function argumentError(op: string): WorkflowError {
	return new WorkflowError("DriverError", `Invalid ${op} arguments`);
}
function capError(message: string): WorkflowError {
	return new WorkflowError("WorldReadCapExceeded", message);
}
function stringArgs(op: string, args: unknown[], min: number, max: number): Array<string | undefined> {
	if (args.length < min || args.length > max) throw argumentError(op);
	for (let index = 0; index < args.length; index++) {
		if (index < min ? typeof args[index] !== "string" : args[index] !== undefined && typeof args[index] !== "string")
			throw argumentError(op);
	}
	return args as Array<string | undefined>;
}
async function workspaceFile(cwd: string, given: string, artifact = false): Promise<string> {
	const root = await fs.realpath(cwd);
	const requested = path.resolve(cwd, given);
	const lexical = path.relative(path.resolve(cwd), requested);
	if (path.isAbsolute(lexical) || lexical === ".." || lexical.startsWith(`..${path.sep}`)) {
		throw new WorkflowError(
			artifact ? "ArtifactPathOutsideWorkspace" : "DriverError",
			"Path is outside the workflow workspace",
		);
	}
	const target = await fs.realpath(requested);
	const relative = path.relative(root, target);
	if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		throw new WorkflowError(
			artifact ? "ArtifactPathOutsideWorkspace" : "DriverError",
			"Path resolves outside the workflow workspace",
		);
	}
	return target;
}
const MIME_BY_EXTENSION: Record<string, string> = {
	".md": "text/markdown",
	".txt": "text/plain",
	".html": "text/html",
	".json": "application/json",
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".svg": "image/svg+xml",
	".csv": "text/csv",
	".zip": "application/zip",
};

// Git argv validation and porcelain parsing ported from pinned Root workflow-git-world-read.ts.
const GIT_SHOW_PREFIX_ARGV = ["rev-parse", "--show-prefix"];
const GIT_STATUS_ARGV = ["status", "--porcelain=v2", "-z", "--branch", "--", "."];
function gitChangedFilesPlan(base: string | undefined): Array<{ argv: string[] }> {
	const tracked = {
		argv: ["diff", "--name-only", "-z", base === undefined ? "HEAD" : validateGitRef(base), "--", "."],
	};
	return base === undefined
		? [tracked, { argv: ["ls-files", "--others", "--exclude-standard", "-z", "--full-name", "--", "."] }]
		: [tracked];
}
function validateGitRef(value: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/.test(value) || value.includes("..")) throw argumentError("git base ref");
	return value;
}
function gitDiffArgv(base: string | undefined, given: string | undefined): string[] {
	let pathspec = ".";
	if (given !== undefined) {
		pathspec = given.replace(/\\/g, "/");
		if (
			!pathspec ||
			pathspec.startsWith("-") ||
			pathspec.startsWith("/") ||
			/^[A-Za-z]:/.test(pathspec) ||
			pathspec.split("/").includes("..")
		)
			throw argumentError("git path");
	}
	return ["diff", "--relative", base === undefined ? "HEAD" : validateGitRef(base), "--", pathspec];
}
function gitLogArgv(count: number): string[] {
	return ["log", `-n${count}`, "--pretty=format:%H%x00%s%x00%an%x00%aI"];
}
function parseGitShowPrefix(text: string): string {
	return text.replace(/\r?\n$/, "");
}
function relativeGitPath(prefix: string, given: string): string {
	if (given.startsWith(prefix)) return given.slice(prefix.length);
	throw new WorkflowError("DriverError", "Git reported a path outside the workflow workspace");
}
function parseGitPathList(text: string, prefix: string): string[] {
	return text
		.split("\0")
		.filter(Boolean)
		.map(given => relativeGitPath(prefix, given));
}
function fieldTail(line: string, count: number): string {
	let offset = 0;
	for (let index = 0; index < count; index++) {
		const next = line.indexOf(" ", offset);
		if (next === -1) return "";
		offset = next + 1;
	}
	return line.slice(offset);
}
function parseGitStatusPorcelainV2(text: string, prefix: string) {
	const staged: string[] = [];
	const unstaged: string[] = [];
	const untracked: string[] = [];
	let branch: string | undefined;
	const records = text.split("\0").filter(Boolean);
	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		if (record.startsWith("# branch.head ")) {
			const head = record.slice("# branch.head ".length);
			if (head !== "(detached)") branch = head;
		} else if (record[0] === "1" || record[0] === "2") {
			const xy = record.split(" ")[1] ?? "..";
			const given = fieldTail(record, record[0] === "1" ? 8 : 9);
			if (record[0] === "2") index++;
			if (!given) continue;
			const relative = relativeGitPath(prefix, given);
			if (xy[0] && xy[0] !== ".") staged.push(relative);
			if (xy[1] && xy[1] !== ".") unstaged.push(relative);
		} else if (record[0] === "u") {
			const given = fieldTail(record, 10);
			if (given) unstaged.push(relativeGitPath(prefix, given));
		} else if (record[0] === "?") {
			const given = fieldTail(record, 1);
			if (given) untracked.push(relativeGitPath(prefix, given));
		}
	}
	return {
		...(branch === undefined ? {} : { branch }),
		clean: !staged.length && !unstaged.length && !untracked.length,
		staged: [...new Set(staged)].sort(),
		unstaged: [...new Set(unstaged)].sort(),
		untracked: [...new Set(untracked)].sort(),
	};
}
function parseGitLog(text: string) {
	return text
		.split(/\r?\n/)
		.filter(Boolean)
		.map(record => {
			const fields = record.split("\0");
			if (fields.length !== 4) throw new WorkflowError("DriverError", "Invalid git log record");
			return { hash: fields[0]!, subject: fields[1]!, author: fields[2]!, date: fields[3]! };
		});
}
