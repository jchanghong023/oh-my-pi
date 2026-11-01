import { type Component, Input, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";

export interface KnowledgeAddWizardResult {
	name: string;
	directory: string;
}

type KnowledgeWizardStep = "name" | "directory" | "confirm";

const STEPS: KnowledgeWizardStep[] = ["name", "directory", "confirm"];

export class KnowledgeAddWizard implements Component {
	#stepIndex = 0;
	#input = new Input();
	#values: KnowledgeAddWizardResult = { name: "", directory: "" };
	#error?: string;

	constructor(
		private readonly onComplete: (result: KnowledgeAddWizardResult) => void,
		private readonly onCancel: () => void,
	) {
		this.#syncInput();
	}

	invalidate(): void {}

	#syncInput(): void {
		const step = STEPS[this.#stepIndex];
		this.#input.setValue(step === "confirm" ? "" : this.#values[step]);
	}

	#advance(): void {
		const step = STEPS[this.#stepIndex];
		if (step === "confirm") {
			this.onComplete({ ...this.#values });
			return;
		}
		const value = this.#input.getValue().trim();
		if (!value) {
			this.#error = `${step} must not be empty`;
			return;
		}
		this.#values[step] = value;
		this.#error = undefined;
		this.#stepIndex++;
		this.#syncInput();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.#stepIndex === 0) this.onCancel();
			else {
				this.#stepIndex--;
				this.#error = undefined;
				this.#syncInput();
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\n") {
			this.#advance();
			return;
		}
		if (STEPS[this.#stepIndex] !== "confirm") this.#input.handleInput(data);
	}

	render(width: number): string[] {
		const step = STEPS[this.#stepIndex];
		const lines = [
			theme.bold(theme.fg("accent", "Add knowledge index")),
			`Step ${this.#stepIndex + 1}/${STEPS.length}: ${step}`,
		];
		if (step === "confirm") {
			lines.push(
				`Name: ${sanitizeText(this.#values.name)}`,
				`Directory: ${sanitizeText(this.#values.directory)}`,
				"",
				theme.fg("dim", "Enter create  Esc back"),
			);
		} else {
			lines.push(
				this.#input.render(Math.max(10, width - 2))[0] ?? "",
				"",
				theme.fg("dim", "Enter next  Esc back/cancel"),
			);
		}
		if (this.#error) lines.push(theme.fg("error", this.#error));
		return lines.map(line => truncateToWidth(line, width));
	}
}
