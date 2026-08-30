import { type Component, Input, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import type { DocsIndexMode } from "../../docs/types";
import { theme } from "../theme/theme";

export interface DocsAddWizardResult {
	name: string;
	directory: string;
	schema: string;
	mode: DocsIndexMode;
}

type DocsWizardStep = "name" | "directory" | "schema" | "mode" | "confirm";

const STEPS: DocsWizardStep[] = ["name", "directory", "schema", "mode", "confirm"];

export class DocsAddWizard implements Component {
	#stepIndex = 0;
	#input = new Input();
	#values: DocsAddWizardResult = { name: "", directory: "", schema: "dft", mode: "fts" };
	#error?: string;

	constructor(
		private readonly onComplete: (result: DocsAddWizardResult) => void,
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
		if (step === "mode" && value !== "fts" && value !== "structured") {
			this.#error = "mode must be fts or structured";
			return;
		}
		if (step === "mode") this.#values.mode = value as DocsIndexMode;
		else this.#values[step] = value;
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
		const lines = [theme.bold(theme.fg("accent", "Add document index")), `Step ${this.#stepIndex + 1}/5: ${step}`];
		if (step === "confirm") {
			lines.push(
				`Name: ${this.#values.name}`,
				`Directory: ${this.#values.directory}`,
				`Schema: ${this.#values.schema}`,
				`Mode: ${this.#values.mode}`,
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
