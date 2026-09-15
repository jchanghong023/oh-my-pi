/**
 * `/skill:<name>` token syntax shared by the composer and the skill prompt
 * pipeline. Kept free of the discovery/settings imports that live in
 * `skills.ts`: the startup composer graph must not pull settings, catalog,
 * session runtime, or LSP modules in (see startup-composer-graph.test.ts).
 */

/**
 * One `/skill:<name>` token delimited by whitespace or line edges. Group 1 is
 * the leading delimiter (empty at line start), group 2 the bare skill name.
 * Global so callers can walk every token; reset `lastIndex` before reuse.
 */
export const SKILL_TOKEN_RE = /(^|\s)\/skill:([^\s/]+)(?=\s|$)/g;

/**
 * Whether `/skill:<name>` tokens in `text` are invocations. False when the
 * draft starts with a different slash command (`/compact /skill:foo`) or a
 * local-execution sigil — `!cmd` / `!!cmd` for the bash tool and `$ cmd` /
 * `$$ cmd` for the python tool. Those handlers run after the skill-command
 * dispatcher and their bodies routinely contain `/skill:<name>` references
 * that are not meant as skill invocations.
 */
export function allowsSkillTokens(text: string): boolean {
	const trimmedStart = text.trimStart();
	if (trimmedStart.startsWith("/skill:")) return true;
	if (trimmedStart.startsWith("/")) return false;
	return !startsWithLocalExecutionPrefix(trimmedStart);
}

/**
 * Whether the (already left-trimmed) draft begins with a TUI local-execution
 * sigil that downstream branches will consume verbatim — `!`/`!!` for the bash
 * tool and `$`/`$$` followed by ASCII whitespace for the python tool. Mirrors
 * `pythonCommandPrefixLength` in `modes/controllers/input-controller` so the
 * two checks agree without forcing a circular import.
 */
function startsWithLocalExecutionPrefix(trimmedStart: string): boolean {
	if (trimmedStart.startsWith("!")) return true;
	if (trimmedStart.charCodeAt(0) !== 36 /* $ */) return false;
	if (trimmedStart.charCodeAt(1) === 123 /* { */) return false;
	const sigilLength = trimmedStart.charCodeAt(1) === 36 /* $ */ ? 2 : 1;
	const next = trimmedStart.charCodeAt(sigilLength);
	if (Number.isNaN(next)) return true;
	return next === 32 /* space */ || next === 9 /* tab */ || next === 10 /* LF */ || next === 13; /* CR */
}
