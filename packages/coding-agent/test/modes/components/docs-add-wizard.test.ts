import { describe, expect, it, vi } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { DocsAddWizard } from "../../../src/modes/components/docs-add-wizard";

function text(component: { render(width: number): string[] }): string {
	return component
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

function typeText(component: { handleInput(data: string): void }, value: string): void {
	for (const character of value) component.handleInput(character);
}

describe("DocsAddWizard step contract (docs hub add flow)", () => {
	it("walks name → directory → confirm and reports both values", async () => {
		await initTheme();
		const onComplete = vi.fn();
		const wizard = new DocsAddWizard(onComplete, vi.fn());
		typeText(wizard, "handbook");
		wizard.handleInput("\n");
		expect(text(wizard)).toContain("Step 2/3: directory");
		typeText(wizard, "/srv/docs");
		wizard.handleInput("\n");
		const confirm = text(wizard);
		expect(confirm).toContain("Step 3/3: confirm");
		expect(confirm).toContain("Name: handbook");
		expect(confirm).toContain("Directory: /srv/docs");
		expect(onComplete).not.toHaveBeenCalled();
		wizard.handleInput("\n");
		expect(onComplete).toHaveBeenCalledWith({ name: "handbook", directory: "/srv/docs" });
	});

	it("rejects an empty step value with an error and stays on the step", async () => {
		await initTheme();
		const wizard = new DocsAddWizard(vi.fn(), vi.fn());
		wizard.handleInput("\n");
		const view = text(wizard);
		expect(view).toContain("Step 1/3: name");
		expect(view).toContain("name must not be empty");
	});

	it("escape cancels on the first step and steps back on later steps, keeping typed values", async () => {
		await initTheme();
		const cancelled = vi.fn();
		const first = new DocsAddWizard(vi.fn(), cancelled);
		first.handleInput("\x1b");
		expect(cancelled).toHaveBeenCalledTimes(1);

		const wizard = new DocsAddWizard(vi.fn(), cancelled);
		typeText(wizard, "kb");
		wizard.handleInput("\n");
		typeText(wizard, "/tmp/kb");
		wizard.handleInput("\n");
		expect(text(wizard)).toContain("Step 3/3: confirm");
		wizard.handleInput("\x1b");
		const directory = text(wizard);
		expect(directory).toContain("Step 2/3: directory");
		expect(directory).toContain("/tmp/kb");
		wizard.handleInput("\x1b");
		const name = text(wizard);
		expect(name).toContain("Step 1/3: name");
		expect(name).toContain("kb");
		expect(cancelled).toHaveBeenCalledTimes(1);
	});
});
