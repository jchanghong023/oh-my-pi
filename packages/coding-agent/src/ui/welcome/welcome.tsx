/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The welcome card (`omp.welcome`): the lockup — the omp mark beside the
 * `omp` wordmark with the version under it —
 * and the session's tip.
 *
 * Terminal look (`src/ui/styles/welcome/welcome.ts`): the gradient logo and
 * half-block wordmark centered, the tip under it. The intro sweeps the
 * logo's gradient on the terminal clock for {@link INTRO_MS} from
 * `introStart`; a native terminal animates its own builtin mark.
 */
import { type Accessor, computed, type JSXNode, Show, type Signal, signal } from "@oh-my-pi/pi-tui";
import type { TspText } from "@oh-my-pi/pi-wire";
import "../styles/welcome";
import { INTRO_MS } from "./logo";
import { isNewTip, type TipKeyStyle, tipText } from "./tips";

/** Terminal look facts of the card. */
export type WelcomeLook = {
	readonly version: string;
	/** Terminal-clock ms the intro started; null at rest. */
	readonly introStart: number | null;
	/** The tip body (keys formatted, links as `link` spans). */
	readonly tip?: TspText;
	/** The tip is a `[NEW]` one (a rainbow tag follows it). */
	readonly isNew?: boolean;
};

export interface WelcomeProps {
	readonly version: Accessor<string>;
	/** The tips.txt line of the session (see `welcomeTip`); undefined shows none. */
	readonly tip: Accessor<string | undefined>;
	/** How the tip's keys read. */
	readonly keys: Accessor<TipKeyStyle>;
	/** Terminal-clock ms the intro started; null at rest. */
	readonly introStart: Accessor<number | null>;
}

export function Welcome(props: WelcomeProps): JSXNode {
	const body = computed(() => {
		const tip = props.tip();
		return tip === undefined ? undefined : tipText(tip, props.keys());
	});
	const look = (): WelcomeLook => {
		const tip = props.tip();
		const text = body();
		return {
			version: props.version(),
			introStart: props.introStart(),
			...(tip !== undefined && text !== undefined ? { tip: text, isNew: isNewTip(tip) } : {}),
		};
	};
	return (
		<card role="omp.welcome" term={look}>
			<row key="lockup" role="omp.welcome.lockup" align="center" gap="md">
				<image key="logo" role="omp.welcome.logo" builtin="omp" alt="omp" w={128} />
				<col key="mark" role="omp.welcome.mark">
					<text
						key="omp.welcome.wordmark"
						role="omp.welcome.wordmark"
						spans={[{ t: "omp", s: "strong" }]}
						wrap="none"
					/>
					<text
						key="omp.welcome.version"
						role="omp.welcome.version"
						spans={() => [{ t: `v${props.version()}`, s: "dim mono" }]}
						wrap="none"
					/>
				</col>
			</row>
			<Show when={() => props.tip() !== undefined}>
				<row key="tip" role="omp.welcome.tip" align="start" gap="sm">
					<icon role="omp.welcome.tip-icon" name="lightbulb" />
					<text
						role="omp.welcome.tip-text"
						text={() => {
							const text = body();
							return typeof text === "string" ? text : undefined;
						}}
						spans={() => {
							const text = body();
							return typeof text === "string" ? undefined : text;
						}}
						wrap="word"
					/>
					<Show when={() => isNewTip(props.tip() ?? "")}>
						<shimmer role="omp.welcome.new" text="新功能" />
					</Show>
				</row>
			</Show>
		</card>
	);
}

/**
 * The welcome card's state: version and intro. `playIntro` starts the sweep on the terminal clock and settles it
 * after {@link INTRO_MS}; a card built with an intro due stays {@link live}
 * until the intro played or was skipped.
 */
export class WelcomeModel {
	readonly version: Signal<string>;
	readonly introStart = signal<number | null>(null);
	/** An intro is due: whoever owns startup will {@link playIntro} or {@link skipIntro}. */
	readonly #introDue: Signal<boolean>;
	#timer: Timer | undefined;

	/**
	 * Whether the card may still change: an intro is due or playing. Its transcript block holds
	 * its settle meanwhile, so a terminal keeps repainting it instead of retiring it to history.
	 */
	readonly live: Accessor<boolean> = () => this.#introDue() || this.introStart() !== null;

	constructor(version: string, options?: { readonly intro?: boolean }) {
		this.version = signal(version);
		this.#introDue = signal(options?.intro === true);
	}

	/** Play the intro from `now` (terminal clock); replays when already playing. */
	playIntro(now = Date.now()): void {
		clearTimeout(this.#timer);
		// Start before clearing the due mark: the card never reads as still in between.
		this.introStart.set(now);
		this.#introDue.set(false);
		this.#timer = setTimeout(() => this.stopIntro(), INTRO_MS);
	}

	/** Settle on the resting logo now. */
	stopIntro(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#introDue.set(false);
		this.introStart.set(null);
	}

	/** No intro this launch (a resumed session, a native terminal): the card is final as it is. */
	skipIntro(): void {
		this.#introDue.set(false);
	}
}
