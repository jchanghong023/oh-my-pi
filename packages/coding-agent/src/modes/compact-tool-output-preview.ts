import type { Component } from "@oh-my-pi/pi-tui";
import { chatTranscriptDisplayPreferences as displayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui/render/render-utils";
import { toolOutputText } from "@oh-my-pi/pi-tui/tools/output-preview";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { getPaddingX, padding } from "@oh-my-pi/pi-tui/utils";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import type { LiveToolOutputSnapshot } from "../session/agent-session-handle";
import { compactToolPreviewInfo } from "./compact-thinking-preview";
import type { InteractiveModeContext } from "./types";

function singleLine(value: string): string {
	return replaceTabs(sanitizeText(plainText(value))).replace(/[\r\n]+/g, " ");
}

/** A text-only projection of session execution facts, independent of transcript tool cards. */
export class CompactToolOutputPreview implements Component {
	#timer?: NodeJS.Timeout;
	#deadline?: number;
	#session?: InteractiveModeContext["viewSession"];
	#sessionId?: string;
	#outputText = new WeakMap<ToolRenderResult<unknown>, string>();

	constructor(
		private readonly ctx: Pick<InteractiveModeContext, "viewSession" | "ui" | "statusLine">,
		private readonly availableRows: () => number = () => 6,
	) {}

	clear(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#deadline = undefined;
		this.#session = undefined;
		this.#sessionId = undefined;
	}

	/** Synchronize even without a visible paint; close only after tool completion and activity stop. */
	observe(event: AgentSessionEvent): void {
		if (
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end"
		)
			this.restore();
	}

	restore(): void {
		this.#source();
	}

	#source(): { call: LiveToolOutputSnapshot; output: string } | undefined {
		const session = this.ctx.viewSession;
		const sessionId = session.sessionManager.getSessionId();
		if (session !== this.#session || sessionId !== this.#sessionId) {
			this.clear();
			this.#session = session;
			this.#sessionId = sessionId;
		}
		let selected: { call: LiveToolOutputSnapshot; output: string } | undefined;
		for (const call of session.getLiveToolOutputSnapshot()) {
			if (!call.result || (selected && call.dispatchOrder <= selected.call.dispatchOrder)) continue;
			let output = this.#outputText.get(call.result);
			if (output === undefined) {
				output = toolOutputText(call.toolName, call.result);
				this.#outputText.set(call.result, output);
			}
			if (output.trim()) selected = { call, output };
		}
		const terminalAt = selected?.call.terminalAt;
		const deadline =
			terminalAt === undefined || this.ctx.statusLine.getTurnElapsedMs() !== null
				? undefined
				: Math.max(terminalAt, this.ctx.statusLine.getLastActivityEndAt() ?? terminalAt) + 3000;
		if (this.#deadline !== deadline) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
			this.#deadline = deadline;
			if (deadline !== undefined && deadline > Date.now()) {
				this.#timer = setTimeout(() => {
					this.#timer = undefined;
					if (
						this.ctx.viewSession === session &&
						this.ctx.viewSession.sessionManager.getSessionId() === sessionId &&
						this.#deadline === deadline
					)
						this.ctx.ui.requestRender();
				}, deadline - Date.now());
				this.#timer.unref?.();
			}
		}
		return deadline !== undefined && deadline <= Date.now() ? undefined : selected;
	}

	render(width: number): readonly string[] {
		const selected = this.#source();
		if (!displayPreferences.compactToolActivity || !selected || width < 1) return [];
		const height = Math.max(0, Math.min(6, Math.floor(this.availableRows())));
		if (height === 0) return [];
		const inset = Math.min(getPaddingX(1), Math.max(0, width - 1));
		const innerWidth = width - inset;
		const { call, output } = selected;
		const info = compactToolPreviewInfo(call.toolName, call.args, call.intent, call.result);
		let details = isRecord(call.result?.details) ? call.result.details : undefined;
		if (call.toolName === "write" && isRecord(details?.xdev) && isRecord(details.xdev.inner))
			details = details.xdev.inner;
		const job = isRecord(details?.async) ? details.async : undefined;
		const state =
			call.terminalAt === undefined
				? "running"
				: job?.state === "cancelled" || details?.cancelled === true
					? "cancelled"
					: call.result?.isError || job?.state === "failed"
						? "failed"
						: "completed";
		const identity = [
			info.name,
			typeof job?.name === "string" ? job.name : undefined,
			typeof job?.jobId === "string" ? job.jobId : undefined,
			state,
		];
		const header = identity.filter(Boolean).join(" · ");
		const target = info.command || info.detail;
		const rows = [truncateToWidth(singleLine(target ? `${header} · ${target}` : header), innerWidth)];
		if (height > 1)
			rows.push(
				...wrapTextWithAnsi(output, innerWidth)
					.filter(row => row.trim().length > 0)
					.slice(-(height - 1)),
			);
		while (rows.length < height) rows.push("");
		const left = padding(inset);
		return rows.map(row => (row ? left + row : ""));
	}

	describe(cx: DescribeContext): NativeNode {
		return { k: "rows", p: { cols: cx.cols, lines: this.render(cx.cols) } };
	}
}
