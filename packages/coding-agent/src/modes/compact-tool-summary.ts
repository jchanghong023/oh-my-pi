import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { editToolRenderer, getEditInputPaths } from "@oh-my-pi/pi-tui/tools/edit";
import { sanitizeText } from "@oh-my-pi/pi-utils";

export interface CompactToolSummary {
	detail: string;
	command?: string;
}

type Fields = Record<string, unknown>;

function fieldsOf(value: unknown): Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function firstText(...values: unknown[]): string | undefined {
	for (const value of values) {
		const result = text(value);
		if (result) return result;
	}
	return undefined;
}

function join(...values: Array<string | undefined>): string {
	return values.filter((value): value is string => !!value).join(" · ");
}

/** Keep a batch representative short enough that its count remains useful. */
function short(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return truncateToWidth(comparable(value), TRUNCATE_LENGTHS.LONG);
}

function stringList(value: unknown, kind: string): string | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const first = short(value.find(item => text(item)));
	if (!first) return undefined;
	return value.length > 1 ? `${first} (${value.length} ${kind})` : first;
}

function taskItem(value: unknown): string | undefined {
	const item = fieldsOf(value);
	return join(short(text(item.agent)), short(text(item.name)), short(text(item.task))) || undefined;
}

function taskTarget(fields: Fields): string | undefined {
	if (!Array.isArray(fields.tasks)) return taskItem(fields);
	const tasks = fields.tasks;
	if (!tasks.length) return undefined;
	let first: string | undefined;
	for (const task of tasks) {
		first = taskItem(task);
		if (first) break;
	}
	return first ? `${first} (${tasks.length} tasks)` : undefined;
}

function astEditTarget(fields: Fields): string {
	const paths = stringList(fields.paths, "paths");
	let ops: string | undefined;
	if (Array.isArray(fields.ops) && fields.ops.length) {
		for (const item of fields.ops) {
			const pattern = short(text(fieldsOf(item).pat));
			if (pattern) {
				ops = `${pattern} (${fields.ops.length} ops)`;
				break;
			}
		}
	}
	return join(paths, ops);
}

function editTarget(fields: Fields): string | undefined {
	const input = text(fields.input);
	if (!input) return undefined;
	// The renderer and its shared path extractor handle complete and streaming inputs.
	const summary = editToolRenderer.activitySummary({ input }, { expanded: false, isPartial: true });
	return summary.detail ?? stringList(getEditInputPaths(input), "paths");
}

function questionTarget(value: unknown): string | undefined {
	if (!Array.isArray(value) || !value.length) return undefined;
	for (const question of value) {
		const label = short(text(fieldsOf(question).question));
		if (label) return value.length > 1 ? `${label} (${value.length} questions)` : label;
	}
	return undefined;
}

function location(fields: Fields): string | undefined {
	const file = text(fields.file);
	if (!file) return undefined;
	return typeof fields.line === "number" && Number.isFinite(fields.line) ? `${file}:${fields.line}` : file;
}

function fallback(name: string, fields: Fields): string {
	switch (name) {
		case "ast_grep":
			return join(text(fields.pat), text(fields.path));
		case "ast_edit":
			return astEditTarget(fields);
		case "openwiki_read":
			return join(text(fields.page), stringList(fields.sections, "sections"));
		case "openwiki_list_wikis":
			return text(fields.workspace) ?? "";
		case "openwiki_list_workspaces":
			return text(fields.wiki) ?? "";
		case "lsp":
			return join(text(fields.action), location(fields), text(fields.symbol), text(fields.query));
		case "debug":
			return join(
				text(fields.action),
				text(fields.program),
				location(fields),
				text(fields.function),
				text(fields.name),
			);
		case "ida":
			return join(text(fields.action), text(fields.db), text(fields.target));
		case "edit":
		case "apply_patch":
			return editTarget(fields) ?? firstText(fields.path, fields.file_path, fields.target) ?? "";
		case "task":
			return taskTarget(fields) ?? "";
		case "todo":
			return join(text(fields.op), text(fields.task), text(fields.phase), stringList(fields.items, "items"));
		case "goal":
			return join(text(fields.op), text(fields.objective));
		case "github":
			return join(
				text(fields.op),
				text(fields.repo),
				firstText(fields.pr) ?? stringList(fields.pr, "PRs"),
				text(fields.run),
				text(fields.query),
				text(fields.path),
			);
		case "security_scan":
			return join(
				text(fields.action),
				text(fields.operation_id),
				text(fields.plan_id),
				text(fields.scan_id),
				text(fields.finding_id),
				text(fields.repository_id),
				text(fields.repository_url),
				text(fields.target_kind),
				stringList(fields.include_paths, "paths"),
			);
		case "memory_edit":
			return join(text(fields.op), text(fields.id));
		case "manage_skill":
			return join(text(fields.action), text(fields.name));
		case "yield":
			// Workpool yield keys are 1-based item numbers, not result content.
			return typeof fields.key === "number" && Number.isSafeInteger(fields.key) && fields.key > 0
				? String(fields.key)
				: "";
		case "ask":
			return questionTarget(fields.questions) ?? "";
		case "context_notes":
			return fields.text === undefined
				? "read"
				: typeof fields.text === "string"
					? fields.text === ""
						? "clear"
						: "write"
					: "";
		case "init_experiment":
			return text(fields.name) ?? "";
		case "log_experiment":
			return join(text(fields.status), text(fields.description));
		case "grep":
			return join(text(fields.pattern), text(fields.path));
		case "knowledge_search":
			return join(text(fields.query), text(fields.path));
		default:
			return firstText(fields.path, fields.target, fields.url, fields.query, fields.pattern) ?? "";
	}
}

function comparable(value: string): string {
	return replaceTabs(sanitizeText(plainText(value))).replace(/[\r\n]+/g, " ");
}

/** Project only request-side intent, commands and known operation/target fields. */
export function summarizeCompactTool(
	name: string,
	args: unknown,
	intent?: unknown,
	operation?: string,
): CompactToolSummary {
	const fields = fieldsOf(args);
	const description = firstText(intent, fields.i, fields.intent, fields.title);
	const command = firstText(operation, fields.command, name === "eval" ? fields.code : undefined);
	if (command)
		return { detail: description && comparable(description) !== comparable(command) ? description : "", command };
	return { detail: description ?? fallback(name, fields) };
}
