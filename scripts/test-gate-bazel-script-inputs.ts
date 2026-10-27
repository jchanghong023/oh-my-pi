import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const bunCommands = new Set([
	"test",
	"build",
	"install",
	"add",
	"remove",
	"update",
	"outdated",
	"link",
	"unlink",
	"pm",
	"x",
	"create",
	"init",
	"upgrade",
	"completions",
	"repl",
	"help",
	"audit",
	"publish",
	"patch",
	"why",
]);

/** Bun's bare built-in commands take precedence over package script shorthand. */
export function packageCommandKind(program: string, command: string | undefined): "script" | "builtin" | "other" {
	if (program === "node") return command === "--run" ? "script" : "other";
	if (command === "run" || command === "run-script") return "script";
	if (program !== "bun" || !command || command.startsWith("-")) return "other";
	if (bunCommands.has(command)) return "builtin";
	return /\.[cm]?[jt]sx?$/.test(command) ? "other" : "script";
}

/** Expand only statically understood package-manager invocations. Unknown shell
 * syntax, commands and recursive scripts must retain the caller's broad input. */
export function packageScriptInputs(
	argv: readonly (string | undefined)[],
	root: string,
	cwd: string | undefined,
	add: (absolute: string, entry: boolean) => void,
): boolean | undefined {
	const executable = argv[0];
	if (!executable) return undefined;
	const program = path
		.basename(executable)
		.replace(/\.exe$/i, "")
		.toLowerCase();
	if (!["bun", "node", "npm", "pnpm", "yarn"].includes(program)) return undefined;
	if (!cwd || !path.isAbsolute(cwd)) return false;
	const active = new Set<string>();
	const words = (command: string): string[][] | undefined => {
		const commands: string[][] = [[]];
		let word = "";
		let started = false;
		let quote = "";
		for (let index = 0; index < command.length; index++) {
			const char = command[index]!;
			if (char === "$" || char === "`" || char === "\\" || char === "\n" || char === "\r") return undefined;
			if (quote) {
				if (char === quote) quote = "";
				else word += char;
				started = true;
			} else if (char === "'" || char === '"') {
				quote = char;
				started = true;
			} else if (/\s/.test(char)) {
				if (started) commands.at(-1)!.push(word);
				word = "";
				started = false;
			} else if (char === ";" || (char === "&" && command[index + 1] === "&")) {
				if (started) commands.at(-1)!.push(word);
				if (commands.at(-1)!.length === 0) return undefined;
				commands.push([]);
				word = "";
				started = false;
				if (char === "&") index++;
			} else if (/[|&<>(){}*?\[\]]/.test(char)) return undefined;
			else {
				word += char;
				started = true;
			}
		}
		if (quote) return undefined;
		if (started) commands.at(-1)!.push(word);
		return commands.every(part => part.length > 0) ? commands : undefined;
	};
	const expandScript = (directory: string, name: string): boolean => {
		const relative = path.relative(root, directory);
		if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
		const manifest = path.join(directory, "package.json");
		add(manifest, false);
		let scripts: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!("scripts" in parsed) ||
				!parsed.scripts ||
				typeof parsed.scripts !== "object" ||
				Array.isArray(parsed.scripts)
			)
				return false;
			scripts = parsed.scripts as Record<string, unknown>;
		} catch {
			return false;
		}
		const key = `${manifest}\0${name}`;
		if (active.has(key) || typeof scripts[name] !== "string") return false;
		active.add(key);
		try {
			for (const scriptName of [`pre${name}`, name, `post${name}`]) {
				const script = scripts[scriptName];
				if (script === undefined) continue;
				if (typeof script !== "string") return false;
				const commands = words(script);
				if (!commands || !commands.every(command => expandCommand(command, directory))) return false;
			}
			return true;
		} finally {
			active.delete(key);
		}
	};
	const expandCommand = (input: readonly (string | undefined)[], directory: string): boolean => {
		let index = 0;
		while (input[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(input[index]!)) index++;
		const executable = input[index++];
		if (!executable) return false;
		const name = path
			.basename(executable)
			.replace(/\.exe$/i, "")
			.toLowerCase();
		if (!["bun", "node", "npm", "pnpm", "yarn"].includes(name)) return false;
		while (input[index]?.startsWith("--cwd")) {
			const option = input[index++]!;
			const next = option === "--cwd" ? input[index++] : option.startsWith("--cwd=") ? option.slice(6) : undefined;
			if (!next) return false;
			directory = path.resolve(directory, next);
		}
		const command = input[index++];
		if (!command) return false;
		// Literal operands supplied by a script can themselves name inputs.
		// Runtime-only forwarded arguments remain the consumer's responsibility.
		const addOperands = (start: number): void => {
			for (const word of input.slice(start)) {
				if (!word) continue;
				const operand = word.startsWith("-") ? word.match(/^--?[^=]+=(.+)$/)?.[1] : word;
				if (operand) add(path.resolve(directory, operand), /\.[cm]?[jt]sx?$/.test(operand));
			}
		};
		const kind = packageCommandKind(name, command);
		if (kind === "script" && (command === "run" || command === "run-script" || command === "--run")) {
			const script = input[index];
			addOperands(index + 1);
			return !!script && expandScript(directory, script);
		}
		if (kind === "script") {
			addOperands(index);
			return expandScript(directory, command);
		}
		if (kind === "builtin") {
			addOperands(index);
			// Test operands are discovery patterns, not necessarily exact files.
			// Other built-ins can also have effects beyond literal source entries.
			return (
				command === "build" &&
				input.slice(index).some(word => {
					if (!word || word.startsWith("-") || !/\.[cm]?[jt]sx?$/.test(word)) return false;
					const entry = path.resolve(directory, word);
					const relative = path.relative(root, entry);
					return !relative.startsWith("..") && !path.isAbsolute(relative) && existsSync(entry);
				})
			);
		}
		if (name !== "bun" && name !== "node") return false;
		if (command.startsWith("-")) return false;
		addOperands(index);
		if (!/\.[cm]?[jt]sx?$/.test(command)) return false;
		const entry = path.resolve(directory, command);
		const relative = path.relative(root, entry);
		add(entry, true);
		return !relative.startsWith("..") && !path.isAbsolute(relative) && existsSync(entry);
	};
	return expandCommand(argv, cwd);
}
