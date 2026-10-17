import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { CustomCommandContext } from "../../types";
import contextTemplate from "./context.md" with { type: "text" };
import type { ReviewContextSelection, ReviewExportSnapshot } from "./types";

type Version = "target" | "base";
type Range = { start: number; end: number };
type InspectedFile = { total: number; ranges: Range[] };

const listSchema = type({ "prefix?": "string", "contains?": "string", "offset?": "number" });
const diffSchema = type({ "start?": "number", "end?": "number" });
const readSchema = type({ path: "string", "version?": "'target' | 'base'", "start?": "number", "end?": "number" });
const searchSchema = type({
	query: "string",
	"prefix?": "string",
	"version?": "'target' | 'base'",
	"offset?": "number",
});
const rangeSchema = type({ start: "number", end: "number" });
const fileSchema = type({
	path: "string",
	reason: "string",
	"version?": "'target' | 'base'",
	"ranges?": rangeSchema.array(),
});
const selectSchema = type({ files: fileSchema.array(), limitations: "string[]" });

function result(value: unknown): AgentToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function nonnegative(value: number | undefined): number {
	const number = value ?? 0;
	if (!Number.isSafeInteger(number) || number < 0) throw new Error("Offset must be a nonnegative integer");
	return number;
}

function lineRange(start: number | undefined, end: number | undefined, total: number): Range {
	const first = start ?? 1;
	const last = end ?? Math.min(first + 399, Math.max(total, 1));
	if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) {
		throw new Error("Line ranges must be positive inclusive integers");
	}
	if (last - first >= 400) throw new Error("Read at most 400 lines per call; continue with nextStart");
	if (first > Math.max(total, 1)) throw new Error(`Start line exceeds totalLines (${total})`);
	return { start: first, end: Math.min(last, total) };
}

function covers(ranges: Range[], wanted: Range): boolean {
	if (wanted.end < wanted.start) return true;
	let next = wanted.start;
	for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
		if (range.start > next) return false;
		next = Math.max(next, range.end + 1);
		if (next > wanted.end) return true;
	}
	return false;
}

/** Analyze only immutable snapshot bytes with an isolated instance of the configured model. */
export async function collectReviewContext(
	snapshot: ReviewExportSnapshot,
	ctx: CustomCommandContext,
	instructions?: string,
	signal?: AbortSignal,
): Promise<ReviewContextSelection> {
	signal?.throwIfAborted();
	const model = ctx.model;
	if (!model) throw new Error("A configured model is required to collect necessary review context");
	const apiKey = await ctx.modelRegistry.getApiKey(model);
	signal?.throwIfAborted();
	if (!apiKey)
		throw new Error(`No model credentials available for ${model.provider}/${model.id}; export not published`);

	const paths = [...new Set(snapshot.paths)].sort();
	const basePaths = [
		...new Set([
			...paths,
			...snapshot.changes.flatMap(change => [change.path, ...(change.previousPath ? [change.previousPath] : [])]),
		]),
	].sort();
	const allowed = new Set(basePaths);
	const inspected = new Map<string, InspectedFile>();
	const limitations = new Set<string>();
	const diffLines = snapshot.diff ? snapshot.diff.split("\n") : [];
	const inspectedDiff: Range[] = [];
	let selection: ReviewContextSelection | undefined;
	let readCount = 0;

	const textLines = async (path: string, version: Version): Promise<string[] | undefined> => {
		signal?.throwIfAborted();
		if (!allowed.has(path)) throw new Error(`Path is not in the frozen snapshot: ${path}`);
		const bytes = await snapshot.readFile(path, version);
		signal?.throwIfAborted();
		if (bytes === undefined) return undefined;
		if (bytes.includes(0)) {
			limitations.add(`Supplemental context ${version}:${path} is binary and was not analyzed as text.`);
			return undefined;
		}
		try {
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			return text ? text.split("\n") : [];
		} catch {
			limitations.add(`Supplemental context ${version}:${path} is not UTF-8 and was not analyzed as text.`);
			return undefined;
		}
	};

	const listTool: AgentTool<typeof listSchema> = {
		name: "snapshot_list",
		label: "List frozen files",
		description: prompt.render(contextTemplate, { list: true }),
		parameters: listSchema,
		async execute(_id, args, toolSignal) {
			toolSignal?.throwIfAborted();
			const filtered = paths.filter(
				path => (!args.prefix || path.startsWith(args.prefix)) && (!args.contains || path.includes(args.contains)),
			);
			const offset = nonnegative(args.offset);
			return result({
				paths: filtered.slice(offset, offset + 200),
				total: filtered.length,
				nextOffset: offset + 200 < filtered.length ? offset + 200 : null,
			});
		},
	};
	const diffTool: AgentTool<typeof diffSchema> = {
		name: "snapshot_diff",
		label: "Read frozen diff",
		description: prompt.render(contextTemplate, { diff: true }),
		parameters: diffSchema,
		async execute(_id, args, toolSignal) {
			toolSignal?.throwIfAborted();
			const range = lineRange(args.start, args.end, diffLines.length);
			const lines = diffLines.slice(range.start - 1, range.end);
			if (lines.join("\n").length > 256 * 1024)
				throw new Error("Diff page is too large; request fewer lines or split the review scope");
			inspectedDiff.push(range);
			return result({
				...range,
				totalLines: diffLines.length,
				lines,
				nextStart: range.end < diffLines.length ? range.end + 1 : null,
			});
		},
	};
	const readTool: AgentTool<typeof readSchema> = {
		name: "snapshot_read",
		label: "Read frozen source",
		description: prompt.render(contextTemplate, { read: true }),
		parameters: readSchema,
		async execute(_id, args, toolSignal) {
			toolSignal?.throwIfAborted();
			const version = args.version ?? "target";
			const lines = await textLines(args.path, version);
			if (!lines) {
				const limitation = `Requested supplemental context ${version}:${args.path} is missing or not readable as text.`;
				limitations.add(limitation);
				return result({ path: args.path, version, unavailable: limitation });
			}
			const range = lineRange(args.start, args.end, lines.length);
			const page = lines.slice(range.start - 1, range.end);
			if (page.join("\n").length > 256 * 1024)
				throw new Error("Source page is too large; request fewer lines or split the review scope");
			const key = `${version}:${args.path}`;
			const viewed = inspected.get(key) ?? { total: lines.length, ranges: [] };
			viewed.ranges.push(range);
			inspected.set(key, viewed);
			readCount++;
			return result({
				path: args.path,
				version,
				...range,
				totalLines: lines.length,
				lines: page,
				nextStart: range.end < lines.length ? range.end + 1 : null,
			});
		},
	};
	const searchTool: AgentTool<typeof searchSchema> = {
		name: "snapshot_search",
		label: "Search frozen sources",
		description: prompt.render(contextTemplate, { search: true }),
		parameters: searchSchema,
		async execute(_id, args, toolSignal) {
			if (!args.query) throw new Error("Search query must not be empty");
			const offset = nonnegative(args.offset);
			const version = args.version ?? "target";
			const matches: Array<{ path: string; line: number; text: string }> = [];
			let found = 0;
			for (const path of version === "base" ? basePaths : paths) {
				toolSignal?.throwIfAborted();
				if (args.prefix && !path.startsWith(args.prefix)) continue;
				const lines = await textLines(path, version);
				if (!lines) continue;
				for (let index = 0; index < lines.length; index++) {
					const text = lines[index]!;
					if (!text.includes(args.query)) continue;
					if (found++ < offset) continue;
					if (matches.length === 100)
						return result({ matches, nextOffset: offset + 100, limitations: [...limitations] });
					// Do not silently crop a matching source line.
					if (text.length > 64 * 1024)
						throw new Error(`Matching line ${path}:${index + 1} is too large; split the review scope`);
					matches.push({ path, line: index + 1, text });
				}
			}
			return result({ matches, nextOffset: null, limitations: [...limitations] });
		},
	};
	const selectTool: AgentTool<typeof selectSchema> = {
		name: "select_context",
		label: "Select review context",
		description: prompt.render(contextTemplate, { select: true }),
		parameters: selectSchema,
		concurrency: "exclusive",
		async execute(_id, args, toolSignal) {
			toolSignal?.throwIfAborted();
			signal?.throwIfAborted();
			if (!covers(inspectedDiff, { start: 1, end: diffLines.length }))
				throw new Error("Read the complete frozen diff before selecting context");
			if (snapshot.changes.some(change => !change.binary) && readCount === 0)
				throw new Error("Read changed source before selecting context");
			if (!args.files.length && !args.limitations.some(item => item.trim()))
				throw new Error("Empty context requires an explicit explanation in limitations");
			const seen = new Set<string>();
			for (const file of args.files) {
				if (!file.reason.trim()) throw new Error(`Context file needs a concrete reason: ${file.path}`);
				const key = `${file.version ?? "target"}:${file.path}`;
				if (seen.has(key)) throw new Error(`Duplicate context file: ${key}`);
				seen.add(key);
				const viewed = inspected.get(key);
				if (!viewed) throw new Error(`Read selected context before including it: ${key}`);
				if (file.ranges && !file.ranges.length) throw new Error(`Empty ranges are not a file selection: ${key}`);
				const ranges = file.ranges ?? [{ start: 1, end: viewed.total }];
				for (const range of ranges) {
					if (
						!Number.isSafeInteger(range.start) ||
						!Number.isSafeInteger(range.end) ||
						range.start < 1 ||
						range.end > viewed.total ||
						(viewed.total > 0 && range.end < range.start)
					)
						throw new Error(`Invalid selected range: ${key}`);
					if (!covers(viewed.ranges, range))
						throw new Error(`Selected context includes unread lines: ${key}:${range.start}-${range.end}`);
				}
			}
			selection = {
				files: args.files,
				limitations: [...new Set([...limitations, ...args.limitations.filter(item => item.trim())])],
			};
			return result({ selectedFiles: selection.files.length, limitations: selection.limitations });
		},
	};
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: [prompt.render(contextTemplate, { system: true })],
			tools: [listTool, diffTool, readTool, searchTool, selectTool],
			messages: [],
		},
		getApiKey: requestedModel => ctx.modelRegistry.getApiKey(requestedModel),
	});
	const abort = () => agent.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	try {
		signal?.throwIfAborted();
		await agent.prompt(
			JSON.stringify({
				scope: snapshot.scope,
				mode: snapshot.mode,
				baseCommit: snapshot.baseCommit,
				targetCommit: snapshot.targetCommit,
				changedFiles: snapshot.changes,
				diffLines: diffLines.length,
				instructions,
				captureLimitations: snapshot.limitations,
			}),
		);
		signal?.throwIfAborted();
		if (agent.state.error) throw new Error(`Context analysis failed: ${agent.state.error}`);
		const last = agent.state.messages.findLast(message => message.role === "assistant");
		if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"))
			throw new Error(last.errorMessage ?? `Context analysis ${last.stopReason}`);
		if (!selection) throw new Error("Context analysis did not complete a structured selection; export not published");
		return selection;
	} finally {
		signal?.removeEventListener("abort", abort);
		agent.abort();
		agent.reset();
	}
}
