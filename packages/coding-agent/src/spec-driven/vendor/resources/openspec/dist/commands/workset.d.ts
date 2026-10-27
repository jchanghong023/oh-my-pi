import type { spawn as nodeSpawn } from 'node:child_process';
import { type LaunchCommand } from '../core/openers.js';
export interface WorksetCreateOptions {
    member?: string[];
    tool?: string;
    json?: boolean;
}
export interface WorksetOpenOptions {
    tool?: string;
    json?: boolean;
}
export interface WorksetRemoveOptions {
    yes?: boolean;
    json?: boolean;
}
interface LaunchResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}
export interface LaunchOptions {
    spawnFn?: typeof nodeSpawn;
}
/**
 * Spawns the opener with this terminal's stdio. Resolves with the
 * child's exit facts (never rejects for a nonzero exit - for a
 * terminal handoff, the session is the command); rejects with
 * workset_launch_failed only when the spawn itself fails. While the
 * child runs, SIGINT/SIGTERM are ignored in this parent: the terminal
 * delivers Ctrl-C to the child, and the parent must survive to report
 * the child's real exit facts (the 128+n contract).
 */
export declare function launchOpenerCommand(command: LaunchCommand, options?: LaunchOptions): Promise<LaunchResult>;
/** 130 for SIGINT, 143 for SIGTERM - the shell's 128+n convention. */
export declare function exitCodeForLaunch(result: LaunchResult): number;
export declare class WorksetCommand {
    create(name: string | undefined, options?: WorksetCreateOptions): Promise<void>;
    private composeFromFlags;
    list(options?: {
        json?: boolean;
    }): Promise<void>;
    open(name: string, options?: WorksetOpenOptions): Promise<void>;
    remove(name: string, options?: WorksetRemoveOptions): Promise<void>;
}
export {};
//# sourceMappingURL=workset.d.ts.map