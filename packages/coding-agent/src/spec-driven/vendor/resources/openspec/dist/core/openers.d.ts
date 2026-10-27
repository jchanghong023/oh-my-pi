import type { WorksetMember } from './worksets.js';
/**
 * The workset opener table (slice 7.1). Supporting a new tool is
 * configuration, not code: every tool is an instance of one of exactly
 * two launch styles - 'workspace-file' (invoke with the generated
 * .code-workspace) or 'attach-dirs' (pre-args plus one attach flag per
 * member; no positional, ever - agent sessions open clean). Users add
 * tools or adjust parameters under the global config file's `openers`
 * key (the git difftool/mergetool pattern).
 */
export type OpenerStyle = 'workspace-file' | 'attach-dirs';
export interface OpenerDefinition {
    id: string;
    label: string;
    style: OpenerStyle;
    command: string;
    /** Pre-args before any attach flags or the workspace-file path. */
    args: string[];
    /** attach-dirs only; one flag + path pair per member. */
    attachFlag: string;
}
/**
 * Temporary kill-switch (2026-06): worksets open only in IDE-style
 * ('workspace-file') tools while the CLI-agent ('attach-dirs') open flow
 * is reworked. The agents (Claude Code, codex) launch in a single primary
 * cwd rather than a true combined multi-root view, which makes "where does
 * my change land?" ambiguous. Default off; set
 * OPENSPEC_ENABLE_CLI_AGENT_OPENERS=1 to restore them (internal rollback seam).
 */
export declare function isCliAgentOpenersEnabled(): boolean;
/** Whether a tool can be opened right now (CLI-agent styles are gated). */
export declare function isOpenerEnabled(opener: OpenerDefinition): boolean;
export declare const BUILTIN_OPENERS: readonly OpenerDefinition[];
export declare function mergeOpenerTable(rawOpeners: unknown, configPath: string): OpenerDefinition[];
export interface OpenerScanOptions {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    /** Stat seam for tests (win32 candidate paths on posix hosts). */
    isExecutableFile?: (candidatePath: string) => boolean;
}
/**
 * PATH availability scan (ported from the deleted workspace openers
 * at f858c19^, sharpened for injectability: the path module is keyed
 * by the injected platform, and a command already carrying a known
 * executable extension matches as-is).
 */
export declare function isOpenerCommandAvailable(command: string, options?: OpenerScanOptions): boolean;
export interface OpenerChoice {
    opener: OpenerDefinition;
    available: boolean;
    /** `(<command> not found on PATH)` when unavailable. */
    note: string | null;
}
/** Table order preserved, available tools first (stable sort). */
export declare function listOpenerChoices(table: OpenerDefinition[], options?: OpenerScanOptions): OpenerChoice[];
export declare function findOpener(table: OpenerDefinition[], id: string): OpenerDefinition | null;
export interface LaunchCommand {
    executable: string;
    args: string[];
    /** The surviving primary member's path. */
    cwd: string;
    label: string;
    style: OpenerStyle;
}
/**
 * Pure argv builder. workspace-file: pre-args + the generated file's
 * absolute path (which also defuses the cursor shim's `agent`
 * first-arg hijack). attach-dirs: pre-args + one attach flag + path
 * pair per surviving member, the primary included (the locked "one
 * attach flag per member"); never a trailing positional - both agent
 * CLIs would read one as a starter prompt, which 7.1 locks out.
 */
export declare function buildLaunchCommand(opener: OpenerDefinition, input: {
    members: WorksetMember[];
    codeWorkspacePath: string;
}): LaunchCommand;
//# sourceMappingURL=openers.d.ts.map