import { Command } from 'commander';
declare const program: Command;
/**
 * Get the full command path for nested commands.
 * For example: 'change show' -> 'change:show'
 */
export declare function getCommandPath(command: Command): string;
/**
 * True when the executing command asked for JSON output — used to suppress the
 * first-run telemetry notice so stdout stays a single valid JSON document.
 *
 * `--json` reaches commands three ways, so a single parsed option is not enough:
 * - declared on the leaf (`openspec status --json`) → `opts().json`
 * - declared on a parent group and read via globals (`openspec workset --json list`)
 *   → `optsWithGlobals().json`
 * - a residual arg on a permissive group that never declares the option
 *   (`openspec store --json`, which detects it from `command.args`) → `args`
 *
 * Suppressing is always safe: the disclosure is only deferred to the next
 * non-JSON run, never lost, whereas printing it on a JSON run corrupts stdout.
 */
export declare function isJsonRun(command: Command): boolean;
/**
 * True for the commands that exist to serve shell completions: the user-facing
 * `openspec completion ...` group and the hidden `__complete` resolver that
 * generated completion scripts call on every Tab press. Tipping either about
 * completions is noise, and `__complete` would burn the one-shot tip invisibly.
 */
export declare function isCompletionRun(commandPath: string): boolean;
/**
 * True for the hidden `__complete` resolver alone. It runs on every Tab press,
 * so the hooks skip telemetry and the completion tip for it entirely.
 */
export declare function isTabCompletionRun(commandPath: string): boolean;
/**
 * True when the first-run completions tip must be deferred rather than shown.
 *
 * Deferring keeps the tip unconsumed, so it still reaches the user on a later
 * run that can actually carry it. All three cases are runs nobody would read a
 * hint from: JSON output, the completion machinery itself, and a stderr that is
 * not a terminal — pipes and the agent-driven runs that dominate this CLI's
 * usage would otherwise burn the user's one-shot tip into a log nobody opens.
 */
export declare function shouldDeferCompletionTip(command: Command, stderrIsTty: boolean): boolean;
export { program };
export declare function runCli(argv?: string[]): void;
//# sourceMappingURL=index.d.ts.map