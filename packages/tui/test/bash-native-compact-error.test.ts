import { describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "../src/native/node";
import { bashToolRenderer } from "../src/tools/bash";
import type { NativeToolView } from "../src/tools/renderer";

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	return (children ?? []).filter((child): child is NativeNode => "k" in child);
}

function outputSection(view: NativeToolView): NativeNode | undefined {
	const box = nodes(view.body)[0];
	return nodes(box?.c).find(child => (child.p as { role?: string } | undefined)?.role === "omp.tool.bash.output");
}

describe("native compact Bash failures", () => {
	it("shows the last two nonblank logical lines as individually clipped rows and retains expanded output", () => {
		const long = `error: ${"x".repeat(300)}`;
		const output = `earlier diagnostic\n\n\x1b[31m${long}\x1b[0m\n  \nlast diagnostic\n\n`;
		const result = { content: [{ type: "text", text: output }], details: { exitCode: 1 }, isError: true };
		const args = { command: "make" };
		const compact = outputSection(
			bashToolRenderer.describeResult(
				result,
				{ expanded: false, isPartial: false, compactToolActivity: true },
				args,
			),
		);
		expect(compact?.k).toBe("col");
		const rows = nodes(compact?.c);
		expect(rows).toHaveLength(2);
		expect(rows.map(row => row.k)).toEqual(["text", "text"]);
		for (const row of rows) {
			expect(row.p).toMatchObject({ wrap: "none", truncate: "end" });
			expect(row.p).not.toHaveProperty("preview");
			expect(row.p).not.toHaveProperty("lines");
		}
		expect(rows[0]?.p).toMatchObject({ spans: [{ t: long }] });
		expect(rows[1]?.p).toMatchObject({ spans: [{ t: "last diagnostic" }] });

		const expanded = outputSection(
			bashToolRenderer.describeResult(result, { expanded: true, isPartial: false, compactToolActivity: true }, args),
		);
		expect(expanded?.k).toBe("ansi");
		expect(expanded?.p).toMatchObject({ text: output.trimEnd() });
	});
});
