import { describe, expect, it } from "bun:test";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolView } from "../src/tool-render";

describe("ToolView xd:// dispatches", () => {
	it("renders successful execute-mode xdev writes as the inner generate_image tool", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [],
					details: {
						xdev: {
							tool: "generate_image",
							mode: "execute",
							args: { subject: "alpine lake" },
							inner: {
								images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://generate_image");
		expect(html).toContain("alpine lake");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});

	it("renders xd://resolve apply cards from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Applied 1 replacement in 1 file." }],
					details: {
						xdev: {
							tool: "resolve",
							mode: "execute",
							args: { reason: "looks correct" },
							inner: {
								action: "apply",
								reason: "looks correct",
								sourceToolName: "ast_edit",
								label: "ast_edit: edit foo.ts",
							},
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://resolve");
		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
		expect(html).toContain("ast_edit: edit foo.ts");
		// The historical args-only path once left the badge as a warn "?".
		expect(html).not.toContain('tv-badge--warn">?');
	});

	it("renders xd://reject discard cards with reject semantics", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Discarded pending action." }],
					details: {
						xdev: {
							tool: "reject",
							mode: "execute",
							args: { reason: "not right" },
							inner: { action: "discard", reason: "not right", sourceToolName: "edit" },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://reject");
		expect(html).toContain("proposed → rejected");
		expect(html).toContain("tv-badge--warn");
		// Not the generic JSON dump.
		expect(html).not.toContain("tv-out-title");
	});

	it("defaults a running xd://reject to discard before details arrive", () => {
		const html = renderToStaticMarkup(<ToolView name="reject" defaultOpen running args={{ reason: "" }} />);

		expect(html).toContain("proposed → rejected");
	});

	it("renders xd://propose plan metadata from unwrapped inner details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="write"
				defaultOpen
				result={{
					content: [{ type: "text", text: "Plan ready for review." }],
					details: {
						xdev: {
							tool: "propose",
							mode: "execute",
							args: { title: "ship it" },
							inner: { planFilePath: "local://ship-it-plan.md", title: "ship it", planExists: true },
						},
					},
				}}
			/>,
		);

		expect(html).toContain("xd://propose");
		expect(html).toContain("plan proposed");
		expect(html).toContain("local://ship-it-plan.md");
	});

	it("keeps historical top-level resolve cards working from args.action", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="resolve"
				defaultOpen
				args={{ action: "apply", reason: "ok" }}
				result={{ content: [], details: { sourceToolName: "ast_edit", label: "edit foo.ts" } }}
			/>,
		);

		expect(html).toContain("proposed → resolved");
		expect(html).toContain("tv-badge--ok");
	});

	it("renders every received wait message without falling back to JSON", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="wait"
				defaultOpen
				args={{}}
				result={{
					content: [{ type: "text", text: "[42] Worker: ready\n\n[43] Reviewer: looks good" }],
					details: {
						op: "wait",
						waited: [
							{ id: "42", from: "Worker", to: "Main", body: "ready", ts: 0 },
							{ id: "43", from: "Reviewer", to: "Main", body: "looks good", ts: 1 },
						],
					},
				}}
			/>,
		);
		expect(html).toContain("← Worker");
		expect(html).toContain("ready");
		expect(html).toContain("← Reviewer");
		expect(html).toContain("looks good");
		expect(html).not.toContain("tv-out-title");
	});

	it("renders settled wait job output", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="wait"
				defaultOpen
				args={{}}
				result={{
					content: [],
					details: {
						op: "wait",
						jobs: [
							{
								id: "a1b2",
								type: "bash",
								status: "completed",
								label: "build",
								durationMs: 25,
								resultText: "Built",
								errorText: "",
							},
						],
					},
				}}
			/>,
		);
		expect(html).toContain("Built");
		expect(html).toContain("1 done");
	});
});

describe("ToolView ask renderer", () => {
	const questions = [
		{
			id: "db",
			question: "Storage backend",
			options: [{ label: "SQLite" }, { label: "Postgres" }],
			recommended: 0,
		},
		{ id: "notes", question: "Notes & caveats", options: [] },
	];

	it("outlines pending questions and marks the recommended option", () => {
		const html = renderToStaticMarkup(<ToolView name="ask" defaultOpen args={{ questions }} />);

		expect(html).toContain("Storage backend");
		expect(html).toContain("Notes &amp; caveats");
		expect(html).toContain("2 questions");
		expect(html).toContain("recommended");
	});

	it("pairs each question with its selection and flags timed-out answers", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ questions }}
				result={{
					content: [{ type: "text", text: "User selected Postgres." }],
					details: {
						results: [
							{
								id: "db",
								question: "Storage backend",
								options: ["SQLite", "Postgres"],
								selectedOptions: ["Postgres"],
								note: "Use the existing database",
								timedOut: true,
							},
							{ id: "notes", question: "Notes & caveats", options: [], selectedOptions: [] },
						],
					},
				}}
			/>,
		);

		const { document } = parseHTML(`<html><body>${html}</body></html>`);
		const selectedLabels = Array.from(document.querySelectorAll(".tv-row"))
			.filter(row => row.querySelector(".tv-row-key")?.textContent === "●")
			.map(row => row.querySelector(".tv-row-val")?.textContent);
		expect(selectedLabels).toEqual(["Postgres"]);
		expect(document.querySelectorAll(".tv-note--warn")).toHaveLength(1);
		expect(document.body.textContent).toContain("Use the existing database");
	});

	it("renders selected option notes under the matching answer", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ questions }}
				result={{
					content: [],
					details: {
						results: [
							{
								id: "notes",
								selectedOptions: [],
								customInput: "none",
								note: { text: "ignored malformed note" },
							},
							{
								id: "db",
								selectedOptions: ["Postgres"],
								noteOption: "Postgres",
								note: "Team standard",
							},
						],
					},
				}}
			/>,
		);

		const { document } = parseHTML(`<html><body>${html}</body></html>`);
		const noteRows = Array.from(document.querySelectorAll(".tv-row")).filter(
			row => row.querySelector(".tv-row-key")?.textContent === "✎",
		);
		expect(noteRows).toHaveLength(2);
		const optionNote = noteRows.find(row => row.textContent?.includes("Team standard"));
		expect(optionNote?.textContent).toContain("Postgres: Team standard");
		const questionBlock = optionNote?.closest(".tv-list");
		expect(questionBlock?.textContent).toContain("Storage backend");
		expect(questionBlock?.textContent).not.toContain("Notes & caveats");
		expect(html).not.toContain("ignored malformed note");
	});

	it("falls back to the result text when details carry no answers", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ questions: [] }}
				result={{ content: [{ type: "text", text: "Ask needs at least one question." }], isError: true }}
			/>,
		);

		expect(html).toContain("at least one question");
	});
});

describe("ToolView native host expansion", () => {
	it("uses an explicit native expand command for the real tool body", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="read"
				host={{ toolsExpanded: true }}
				args={{ path: "actual.md" }}
				result={{ content: [{ type: "text", text: "full actual output" }] }}
			/>,
		);
		const expanded: string[] = [];
		new HTMLRewriter()
			.on("button.tv-head", {
				element(element) {
					expanded.push(element.getAttribute("aria-expanded") ?? "");
				},
			})
			.transform(html);
		expect(expanded).toEqual(["true"]);
		expect(html).toContain("full actual output");
	});
	it("lets native collapse override defaultOpen while leaving undefined callers unchanged", () => {
		const collapsed = renderToStaticMarkup(
			<ToolView
				name="read"
				defaultOpen
				host={{ toolsExpanded: false }}
				result={{ content: [{ type: "text", text: "body only when open" }] }}
			/>,
		);
		const ordinary = renderToStaticMarkup(
			<ToolView name="read" defaultOpen result={{ content: [{ type: "text", text: "body only when open" }] }} />,
		);
		expect(collapsed).toContain('aria-expanded="false"');
		expect(collapsed).not.toContain("body only when open");
		expect(ordinary).toContain('aria-expanded="true"');
		expect(ordinary).toContain("body only when open");
	});
});
