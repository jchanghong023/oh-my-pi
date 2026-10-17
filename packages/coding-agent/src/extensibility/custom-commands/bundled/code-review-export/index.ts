import { BorderedLoader } from "@oh-my-pi/pi-tui/overlays/bordered-loader";
import type { CustomCommand, CustomCommandAPI, CustomCommandContext } from "../../types";
import { extractReviewPrRefFromArgs, liveCommandCwd, selectReviewChoice } from "../review";
import { resolveLocalReviewTarget } from "../review/target";
import { writeReviewBundle } from "./bundle";
import { captureReviewExportSnapshot } from "./snapshot";
import type { ReviewExportResult, ReviewExportScope } from "./types";

export class CodeReviewExportCommand implements CustomCommand {
	name = "code-review-export";
	description = "Export frozen changes and review instructions to .tmp/review-bundle.zip without calling a model";

	constructor(private readonly api: CustomCommandAPI) {}

	async execute(args: string[], ctx: CustomCommandContext): Promise<string | undefined> {
		const cwd = liveCommandCwd(this.api, ctx);
		const parsed = extractReviewPrRefFromArgs(args);
		let instructions = parsed.extraInstructions || undefined;
		let scope: ReviewExportScope;
		if (parsed.prRef) {
			scope = { kind: "pr", repo: parsed.prRef.repo, number: parsed.prRef.number };
		} else if (!ctx.hasUI) {
			scope = { kind: "uncommitted" };
		} else {
			const choice = await selectReviewChoice(ctx, cwd, { includeCustom: !instructions });
			if (!choice) return undefined;
			if (choice.kind === "pr") {
				scope = { kind: "pr", repo: choice.ref.repo, number: choice.ref.number };
			} else if (choice.kind === "custom") {
				instructions = await ctx.ui.editor(
					"Enter custom review instructions",
					"Review the following:\n\n",
					undefined,
					{ promptStyle: true },
				);
				if (!instructions?.trim()) return undefined;
				scope = { kind: "uncommitted" };
			} else if (choice.kind === "uncommitted") {
				// Capture staged, unstaged and untracked content without /review's display filtering.
				scope = { kind: "uncommitted" };
			} else {
				const target = await resolveLocalReviewTarget(choice.kind, cwd, ctx.ui);
				if (!target) return undefined;
				if (choice.kind === "commit" && target.targetRef) {
					scope = { kind: "commit", ref: target.targetRef };
				} else if (choice.kind === "base-branch" && target.baseRef && target.targetRef) {
					scope = { kind: "base-branch", baseRef: target.baseRef, targetRef: target.targetRef };
				} else {
					throw new Error("Review target did not provide the selected Git identities");
				}
			}
		}

		const run = async (loaderSignal?: AbortSignal): Promise<ReviewExportResult> => {
			const signal = ctx.signal
				? loaderSignal
					? AbortSignal.any([ctx.signal, loaderSignal])
					: ctx.signal
				: loaderSignal;
			signal?.throwIfAborted();
			ctx.ui.setStatus("code-review-export", "Capturing frozen review scope…");
			const snapshot = await captureReviewExportSnapshot(cwd, scope, signal);
			try {
				ctx.ui.setStatus("code-review-export", "Writing and validating review bundle…");
				return await writeReviewBundle(snapshot, { args, instructions }, signal);
			} finally {
				await snapshot.dispose();
			}
		};
		try {
			let result: ReviewExportResult;
			if (ctx.hasUI) {
				let started = false;
				const outcome = await ctx.ui.custom<{ result?: ReviewExportResult; error?: unknown }>(
					(tui, theme, _keys, done) => {
						started = true;
						const loader = new BorderedLoader(tui, theme, "Exporting code review bundle…");
						run(loader.signal).then(
							value => done({ result: value }),
							error => done({ error }),
						);
						return loader;
					},
				);
				// RPC UI supports the same review selectors, but custom components are a no-op.
				if (!started) result = await run();
				else if (outcome?.error !== undefined) throw outcome.error;
				else if (outcome?.result) result = outcome.result;
				else throw new Error("Review export ended without a bundle");
			} else {
				result = await run();
			}
			const limitations = result.limitations.length
				? `\nLimitations:\n${result.limitations.map(item => `- ${item}`).join("\n")}`
				: "\nLimitations: none reported.";
			ctx.ui.notify(
				`Exported ${result.path}\nScope: ${result.mode}\nCommits: ${result.baseCommit ?? "empty tree"} → ${result.targetCommit}\n${result.fileCount} files, ${result.sourceLines} source lines; ${result.uncompressedBytes} bytes uncompressed, ${result.compressedBytes} bytes ZIP.${limitations}\nNo model was called. No review or upload was performed.`,
				result.limitations.length ? "warning" : "info",
			);
		} catch (error) {
			const cancelled = error instanceof Error && error.name === "AbortError";
			ctx.ui.notify(
				cancelled
					? "Code review export cancelled."
					: `Code review export failed: ${error instanceof Error ? error.message : String(error)}`,
				cancelled ? "info" : "error",
			);
		} finally {
			ctx.ui.setStatus("code-review-export", undefined);
		}
		return undefined;
	}
}

export default CodeReviewExportCommand;
