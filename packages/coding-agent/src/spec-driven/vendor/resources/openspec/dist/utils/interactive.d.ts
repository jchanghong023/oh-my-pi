import type { Readable, Writable } from 'node:stream';
export type InteractiveOptions = {
    /**
     * Explicit "disable prompts" flag passed by internal callers.
     */
    noInteractive?: boolean;
    /**
     * Commander-style negated option: `--no-interactive` sets this to false.
     */
    interactive?: boolean;
};
/**
 * Resolves whether non-interactive mode is requested.
 * Handles both explicit `noInteractive: true` and Commander.js style `interactive: false`.
 * Use this helper instead of manually checking options.noInteractive to avoid bugs.
 */
export declare function resolveNoInteractive(value?: boolean | InteractiveOptions): boolean;
export declare function isInteractive(value?: boolean | InteractiveOptions): boolean;
/**
 * True when a prompt failed because no answer could be read — an agent or a
 * script that ran the command with stdin closed, a CI job, or a shell whose
 * stdin is not a terminal. @inquirer rejects those with `User force closed
 * the prompt with 0 null`, which is accurate and useless: it names no flag
 * and no next step (#1479).
 *
 * Two things it deliberately is not:
 *
 * - It is not a substitute for `isInteractive()`. This classifies a prompt
 *   that has *already failed*, so piped answers are unaffected: an answer
 *   that arrives resolves the prompt and never reaches this check. Refusing
 *   to prompt up front would break `printf 'y\n' | openspec archive ...`,
 *   which works today.
 * - It is not a cancellation check. Ctrl-C raises the same error class, and
 *   it reaches a process whose stdin is a pipe just as easily as one at a
 *   terminal, so the SIGINT signal - not the terminal - is what proves
 *   somebody was there and chose to quit.
 *
 * Beyond that it defers to `isInteractive()`, so `CI`, `OPEN_SPEC_INTERACTIVE=0`
 * and `--no-interactive` count even when a runner allocated a pty. It also
 * counts a redirected stdout: `confirmPrompt` drops to the plain reader whenever
 * *either* stream is not a TTY, so a stdin-TTY-but-stdout-redirected run
 * (`openspec archive x > log.txt` from a terminal) that hits EOF must classify
 * the same way the prompt was selected — otherwise it would leak the raw
 * `ExitPromptError` instead of the `--yes` guidance.
 */
export declare function isNonInteractivePromptError(error: unknown, value?: boolean | InteractiveOptions): boolean;
export type ConfirmPrompt = {
    message: string;
    default: boolean;
};
/**
 * Ask a yes/no question. A real terminal gets @inquirer's rich prompt;
 * everything else — a pipe, a file redirect, an agent that captures stdout —
 * reads one plain line instead.
 *
 * @inquirer renders `confirm` by writing ANSI cursor-movement escape sequences,
 * and it emits them even when stdout is not a TTY. Redirected to a file those
 * sequences are noise, and in some non-TTY hosts the render loop never settles
 * and repeats `ESC[NNG` cursor moves until the disk fills (#1526). Reading
 * the answer ourselves keeps the single piped answer @inquirer ever supported
 * working (`printf 'y\n' | openspec archive ...`) without emitting any escapes.
 *
 * `io` overrides the streams; it exists for tests and mirrors @inquirer's own
 * `{ input, output }` context. Production callers pass only the prompt.
 */
export declare function confirmPrompt(prompt: ConfirmPrompt, io?: {
    input?: Readable;
    output?: Writable;
}): Promise<boolean>;
/**
 * Whether a spinner can safely render to `stream`.
 *
 * ora decides how many lines to erase with `ceil(width / stream.columns)`, so a
 * TTY that reports zero columns makes that count `Infinity` and `clear()` never
 * ends: the spinner emits cursor-up/clear-line escapes as fast as it can and the
 * command never finishes (#2106). Zero-width TTYs are real — a pty inherited
 * from a pre-commit runner such as lefthook, or `script -qec` — and nothing can
 * be drawn in zero columns anyway, so refuse the spinner and let the caller fall
 * back to its plain output.
 */
export declare function canRenderSpinner(stream?: {
    isTTY?: boolean;
    columns?: number;
}): boolean;
//# sourceMappingURL=interactive.d.ts.map