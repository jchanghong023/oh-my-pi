/**
 * Split command arguments on spaces/tabs.
 *
 * Default mode treats prose apostrophes literally: a `'`/`"` only delimits when it starts an
 * argument or follows an option `=`, and a matching quote ends one (`--model="model selector"`
 * stays one argument; `don't stop` splits into `don't`, `stop`). `strict` applies shell-style
 * quoting and escapes instead and throws on an unterminated quote or trailing backslash.
 * `literalBackslashesAfter` keeps path separators in the value after that option,
 * while allowing an unquoted backslash to escape a space or tab unless it separates a
 * trailing path separator from the next long option.
 */
export function parseCommandArgs(
	argsString: string,
	options?: { strict?: boolean; preserveEmpty?: boolean; literalBackslashesAfter?: string },
): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;
	let started = false;
	const preserveEmpty = options?.strict || options?.preserveEmpty;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];
		if (options?.strict && char === "\\" && inQuote !== "'") {
			const next = argsString[i + 1];
			const after = options.literalBackslashesAfter;
			const literal = after !== undefined && args.at(-1) === after;
			if (!literal && next === undefined) throw new Error("Incomplete command escape.");
			const escape = literal
				? inQuote === null && (next === " " || next === "\t") && !/^[ \t]+--/u.test(argsString.slice(i + 1))
				: inQuote === null || next === '"' || next === "\\" || next === "$" || next === "`";
			if (next !== undefined && escape) {
				current += next;
				started = true;
				i++;
				continue;
			}
		}
		if (inQuote) {
			if (char === inQuote) {
				inQuote = null;
			} else {
				current += char;
			}
		} else if ((char === '"' || char === "'") && options?.strict) {
			inQuote = char;
			started = true;
		} else if ((char === '"' || char === "'") && (!started || current.endsWith("="))) {
			const close = findClosingQuote(argsString, i);
			current += close === -1 ? char : argsString.slice(i + 1, close);
			started = true;
			if (close !== -1) i = close;
		} else if (char === " " || char === "\t") {
			if (current || (preserveEmpty && started)) {
				args.push(current);
			}
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}

	if (options?.strict && inQuote) throw new Error("Unterminated command quote.");
	if (current || (preserveEmpty && started)) {
		args.push(current);
	}

	return args;
}

/** Whether the first character opens a quoted argument in the default argument syntax. */
export function startsWithQuotedCommandArg(argsString: string): boolean {
	const quote = argsString[0];
	return (quote === "'" || quote === '"') && findClosingQuote(argsString, 0) !== -1;
}

/** Index of the quote matching `argsString[open]` that ends an argument, or -1 when none does. */
function findClosingQuote(argsString: string, open: number): number {
	const quote = argsString[open];
	for (let i = open + 1; i < argsString.length; i++) {
		const next = argsString[i + 1];
		if (argsString[i] === quote && (next === undefined || next === " " || next === "\t")) return i;
	}
	return -1;
}

/**
 * Substitute argument placeholders in template content
 * Supports $1, $2, ... for positional args, $@ and $ARGUMENTS for all args
 *
 * Note: Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
	const allArgs = args.join(" ");

	return content.replace(
		/\$@\[(\d+)(?::(\d*)?)?\]|\$ARGUMENTS|\$@|\$(\d+)/g,
		(match, startRaw?: string, lengthRaw?: string, positionalNum?: string) => {
			if (positionalNum !== undefined) {
				const index = Number.parseInt(positionalNum, 10) - 1;
				return args[index] ?? "";
			}

			if (startRaw !== undefined) {
				const start = Number.parseInt(startRaw, 10);
				if (!Number.isFinite(start) || start < 1) return "";
				const startIndex = start - 1;
				if (startIndex >= args.length) return "";

				if (lengthRaw === undefined || lengthRaw === "") {
					return args.slice(startIndex).join(" ");
				}

				const length = Number.parseInt(lengthRaw, 10);
				if (!Number.isFinite(length) || length <= 0) return "";
				return args.slice(startIndex, startIndex + length).join(" ");
			}

			if (match === "$ARGUMENTS" || match === "$@") {
				return allArgs;
			}

			return match;
		},
	);
}
