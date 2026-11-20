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

describe("ToolView task renderer", () => {
	it("renders batch items by name with their task or numbered steps", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="task"
				defaultOpen
				args={{
					context: "# Goal\nship it",
					tasks: [
						{ name: "Fixer", agent: "task", task: "Patch the parser.", solutionSpace: "one fix" },
						{
							name: "Auditor",
							agent: "scout",
							steps: ["Map the callers.", "Report risky ones."],
							solutionSpace: "open",
						},
					],
				}}
			/>,
		);

		expect(html).toContain("Fixer");
		expect(html).toContain("Patch the parser.");
		expect(html).toContain("2 steps");
		expect(html).toContain("step 1/2");
		expect(html).toContain("Map the callers.");
		expect(html).toContain("step 2/2");
		expect(html).toContain("Report risky ones.");
		expect(html).toContain("2 tasks");
	});

	it("labels a flat stepped spawn by its first step when unnamed", () => {
		const html = renderToStaticMarkup(
			<ToolView name="task" args={{ agent: "task", steps: ["\n  Read the spec.\nThen more", "Write it."] }} />,
		);

		expect(html).toContain("Read the spec.");
		expect(html).not.toContain("Then more");
	});
});

describe("ToolView ask renderer", () => {
	const form = `<form>
		<fieldset><legend>Storage <strong>backend</strong></legend>
			<label><input type="radio" name="db" value="sqlite" checked>SQLite</label>
			<label><input type="radio" name="db" value="postgres">Postgres</label>
		</fieldset>
		<fieldset><legend>Notes &amp; caveats</legend><textarea name="notes"></textarea></fieldset>
		<input type="hidden" name="token" value="private">
		<input type="submit" name="submit" value="Send">
	</form>`;

	it("outlines pending native forms and counts distinct visible fields", () => {
		const html = renderToStaticMarkup(<ToolView name="ask" defaultOpen args={{ html: form }} />);
		const { document } = parseHTML(`<html><body>${html}</body></html>`);

		expect(document.body.textContent).toContain("Storage backend");
		expect(document.body.textContent).toContain("Notes & caveats");
		expect(document.body.textContent).toContain("2 fields");
		expect(document.querySelectorAll(".tv-row")).toHaveLength(2);
		expect(document.querySelectorAll("form, input, textarea, strong")).toHaveLength(0);
		expect(document.body.textContent).not.toContain("private");
	});

	it("uses captions or field names when pending forms have no legends", () => {
		const captioned = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: '<form><label>Deployment region<input name="region"></label>' }}
			/>,
		);
		const unnamedCaption = renderToStaticMarkup(
			<ToolView name="ask" defaultOpen args={{ html: '<form><input name="region"><textarea name="notes">' }} />,
		);

		expect(captioned).toContain("Deployment region");
		expect(unnamedCaption).toContain("region");
		expect(unnamedCaption).toContain("notes");
		expect(unnamedCaption).toContain("2 fields");
	});

	it("renders structured field answers and flags form timeouts", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: form }}
				result={{
					content: [{ type: "text", text: "Raw form data fallback" }],
					details: {
						answers: [
							{ name: "db", question: "Storage backend", answer: "Postgres" },
							{ name: "notes", question: "Notes & caveats", answer: "" },
						],
						timedOut: true,
					},
				}}
			/>,
		);

		const { document } = parseHTML(`<html><body>${html}</body></html>`);
		const answerRows = Array.from(document.querySelectorAll(".tv-row"))
			.filter(row => row.querySelector(".tv-row-key")?.textContent === "✓")
			.map(row => row.querySelector(".tv-row-val")?.textContent);
		expect(answerRows).toEqual(["Postgres"]);
		expect(document.body.textContent).toContain("(no answer)");
		expect(document.body.textContent).not.toContain("Raw form data fallback");
		expect(document.querySelectorAll(".tv-note--warn")).toHaveLength(1);
		expect(document.querySelector(".tv-note--warn")?.textContent).toContain("not a user choice");
	});

	it("attaches option notes to the matching field and question without rendering HTML", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: form }}
				result={{
					content: [],
					details: {
						answers: [
							{ name: "primary", question: "Storage backend", answer: "Postgres" },
							{ name: "replica", question: "Storage backend", answer: "SQLite" },
						],
						notes: [
							{ name: "replica", question: "Storage backend", option: "SQLite", text: "Read-only replica" },
							{
								name: "primary",
								question: "Storage backend",
								option: "Postgres",
								text: '<img src=x onerror="alert(1)">Team standard',
							},
							{ name: "primary", question: "Different question", option: "Postgres", text: "Wrong question" },
							{ name: "primary", question: "Storage backend", option: "Postgres", text: { malformed: true } },
						],
					},
				}}
			/>,
		);

		const { document } = parseHTML(`<html><body>${html}</body></html>`);
		const notes = Array.from(document.querySelectorAll(".tv-note"));
		expect(notes).toHaveLength(2);
		expect(notes[0]?.textContent).toContain('Postgres: <img src=x onerror="alert(1)">Team standard');
		expect(notes[0]?.parentElement?.textContent).toContain("Postgres");
		expect(notes[0]?.parentElement?.textContent).not.toContain("SQLite");
		expect(notes[1]?.textContent).toContain("SQLite: Read-only replica");
		expect(notes[1]?.parentElement?.textContent).not.toContain("Postgres");
		expect(document.body.textContent).not.toContain("Wrong question");
		expect(document.querySelectorAll("img, script, [onerror]")).toHaveLength(0);
	});

	it("renders valid persisted answers despite malformed args and partial details", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: { incomplete: true } }}
				result={{
					content: [],
					details: {
						answers: [
							null,
							"invalid",
							{ name: "bad", question: "Ignore this question", answer: 42 },
							{ name: "db", question: "Recovered question", answer: "<script>literal answer</script>" },
						],
						notes: [null, { name: "db", question: "Recovered question", option: "value", text: null }],
						timedOut: "true",
					},
				}}
			/>,
		);
		const { document } = parseHTML(`<html><body>${html}</body></html>`);

		expect(document.body.textContent).toContain("Recovered question");
		expect(document.body.textContent).toContain("<script>literal answer</script>");
		expect(document.body.textContent).not.toContain("Ignore this question");
		expect(document.querySelectorAll("script, .tv-note")).toHaveLength(0);
	});

	it("outlines partially streamed markup and decodes entities safely", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{
					html: '<form><fieldset><legend>Storage &amp; &#x1f4be; &#1114112; &lt;img src=x onerror=alert(1)&gt;</legend><input name="db"',
				}}
			/>,
		);
		const { document } = parseHTML(`<html><body>${html}</body></html>`);

		expect(document.body.textContent).toContain("Storage & 💾 &#1114112; <img src=x onerror=alert(1)>");
		expect(document.querySelectorAll(".tv-row")).toHaveLength(1);
		expect(document.querySelectorAll("img, input, [onerror]")).toHaveLength(0);
	});

	it("falls back to result text when the producer returns no answers", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="ask"
				defaultOpen
				args={{ html: "<form></form>" }}
				result={{
					content: [{ type: "text", text: "Error: the form has no named controls." }],
					details: { answers: [] },
				}}
			/>,
		);

		expect(html).toContain("the form has no named controls");
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

describe("ToolView web_search renderer", () => {
	it("shows each source's cleaned excerpt instead of the numbered listing when there is no answer", () => {
		const html = renderToStaticMarkup(
			<ToolView
				name="web_search"
				defaultOpen
				args={{ query: "bun expect" }}
				result={{
					content: [{ type: "text", text: "[1] Src One\n    https://example.com/a\n    LISTING_ONLY_MARKER" }],
					details: {
						response: {
							provider: "parallel",
							sources: [
								{ title: "Src One", url: "https://example.com/a", snippet: "\n  first\t excerpt\n```\nsecond" },
							],
						},
					},
				}}
			/>,
		);

		expect(html).not.toContain("LISTING_ONLY_MARKER");
		expect(html).toContain('<span class="tv-excerpt">first excerpt</span><span class="tv-excerpt">second</span>');
	});
});
