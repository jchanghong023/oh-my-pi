import type { GateCommand } from "./test-gate-runtime";

export interface GateCommandRisk {
	priority: number;
	reason: string;
}

/** Engineering heuristics, not invented historical failure rates. Scheduling
 * metadata stays outside Bazel action inputs so reprioritization preserves hits. */
export function gateCommandRisk(command: GateCommand): GateCommandRisk {
	const label = command.label;
	if (/^build\//.test(label)) return { priority: 100, reason: "generated native bindings must precede their readers" };
	if (/^test\/repository scripts/.test(label) || /test-gate|fulltest|slowtest|fastcheck/.test(label))
		return { priority: 95, reason: "changed gate orchestration and cancellation boundaries" };
	if (/^static\/TS types.*(?:coding-agent|pi-utils|pi-agent-core)/.test(label))
		return { priority: 90, reason: "shared interfaces and high-fanout consumers" };
	if (/^test\/Rust|^static\/Rust/.test(label))
		return { priority: 85, reason: "native toolchain and platform integration boundary" };
	if (
		/rpc|mcp|stdio|pty|terminal|cli|spawn|offline|company|config|session|team|subprocess|worker|index|wiki/i.test(
			label,
		)
	)
		return { priority: 80, reason: "stateful configuration, concurrency, or platform boundary" };
	if (/^smoke\//.test(label)) return { priority: 75, reason: "public CLI and native integration boundary" };
	if (/^static\/TS types/.test(label)) return { priority: 70, reason: "type errors block package consumers" };
	if (/^static\//.test(label)) return { priority: 60, reason: "format and lint checks after higher-risk interfaces" };
	return { priority: 50, reason: "remaining independent regression coverage" };
}
