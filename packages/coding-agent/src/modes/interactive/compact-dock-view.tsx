/** @jsxImportSource @oh-my-pi/pi-tui */
import { type Accessor, type JSXNode, signal } from "@oh-my-pi/pi-tui";
import type { ShimmerMode } from "@oh-my-pi/pi-tui/text/shimmer";
import type { Shell } from "../../ui/shell";
import type { CompactActionRow } from "../compact-thinking-preview";

const empty = () => [];

/** Shared by the startup frame and live dock. None of these rows enters the transcript. */
export function mountCompactDock(
	shell: Shell,
	visible: Accessor<boolean>,
	activity: (width: number) => readonly (CompactActionRow | undefined)[] = empty,
	output: (width: number) => readonly string[] = empty,
	diff: (width: number) => readonly string[] = empty,
	waiting: Accessor<boolean> = () => false,
	shimmer: Accessor<ShimmerMode | "disabled"> = () => "disabled",
	interrupt: () => void = () => {},
): () => void {
	const revision = signal(0);
	const paint = (render: (width: number) => readonly string[]) => (width: number) => {
		revision();
		return render(width);
	};
	const paintDiff = paint(diff);
	const paintOutput = paint(output);
	shell.dock.slot("compact").set(
		() => () =>
			visible() && (
				<col key="compact">
					<canvas role="omp.compact.diff" paint={paintDiff} />
					<canvas role="omp.compact.output" paint={paintOutput} />
					<col
						role="omp.compact.activity"
						onAction={act => {
							if (act === "interrupt") interrupt();
						}}
					>
						{() => {
							revision();
							const width = shell.size().columns;
							const stop = shell.native() && waiting();
							const [model, agent] = activity(width);
							const action = (entry: CompactActionRow | undefined): JSXNode => {
								if (!entry) return <text text=" " wrap="none" />;
								const mode = shimmer();
								return [
									width > 1 && <text text=" " wrap="none" />,
									entry.running && mode !== "disabled" ? (
										<shimmer text={entry.word} mode={mode} />
									) : (
										<text spans={[{ t: entry.word, s: entry.tone }]} wrap="none" />
									),
									entry.detail.length > 0 && (
										<text spans={[{ t: "  " }, ...entry.detail.map(part => ({ t: part.text, s: part.tone }))]} wrap="none" />
									),
								];
							};
							return [
								<row>{action(model)}</row>,
								<row>
									<row grow={1}>{action(agent)}</row>
									{stop && <text role="omp.compact.wait.stop" actions={{ click: "interrupt" }} text="Stop" />}
								</row>,
							];
						}}
					</col>
				</col>
			),
	);
	return () => revision.set(revision.peek() + 1);
}

