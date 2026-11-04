import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "../src/config/settings";
import { WriteTool } from "../src/tools/write";
import type { ToolSession } from "../src/tools";

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
	result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");

describe("personal tool argument correction feedback", () => {
	it("returns parse, schema and unavailable-tool failures to the next model turn without replaying a successful call", async () => {
		const executed: string[] = [];
		const schema = type({ value: "string" });
		const tool: AgentTool<typeof schema> = {
			name: "echo",
			label: "Echo",
			description: "Echo a value",
			parameters: schema,
			async execute(_id, args) {
				executed.push(args.value);
				return { content: [{ type: "text", text: `accepted:${args.value}` }] };
			},
		};
		const tools: AgentTool[] = [
			tool,
			...Array.from({ length: 21 }, (_, index) => ({
				...tool,
				name: `fixture_${String(index).padStart(2, "0")}`,
			})),
		];
		const model = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "parse",
							name: "echo",
							arguments: { __parseError: "Expected comma", __rawJson: '{"value": nope}' },
						},
						{ type: "toolCall", id: "schema", name: "echo", arguments: {} },
						{ type: "toolCall", id: "unknown", name: "bad_echo", arguments: { value: "do-not-run" } },
						{ type: "toolCall", id: "good", name: "echo", arguments: { value: "once" } },
					],
				},
				{ content: ["done"] },
			],
		});
		const messages = await agentLoop(
			[{ role: "user", content: "perform the requested calls", timestamp: 1 }],
			{ systemPrompt: [""], messages: [], tools },
			{ model: model.model, convertToLlm: messages => messages as never },
			undefined,
			model.stream,
		).result();
		const results = new Map(
			messages
				.filter((message): message is ToolResultMessage => message.role === "toolResult")
				.map(message => [message.toolCallId, message]),
		);
		expect(executed).toEqual(["once"]);
		expect(model.calls).toHaveLength(2);
		const parse = results.get("parse")!;
		expect(parse.isError).toBe(true);
		expect(text(parse)).toContain("Expected comma");
		expect(text(parse)).toContain("not run");
		expect(text(parse)).toContain("valid JSON");
		expect(text(parse)).toContain("repeat successful");
		const invalid = results.get("schema")!;
		expect(invalid.isError).toBe(true);
		expect(text(invalid)).toContain("Received arguments:");
		expect(text(invalid)).toContain("not run");
		expect(text(invalid)).toContain("call the tool again");
		const unknown = results.get("unknown")!;
		expect(unknown.isError).toBe(true);
		expect(text(unknown)).toContain("Tool bad_echo not found.");
		expect(text(unknown)).toContain("Did you mean echo?");
		expect(text(unknown)).toContain("not executed");
		const roster = text(unknown).split("Tools in this request: ")[1]!.split(".")[0]!;
		expect(roster).toContain("fixture_18, ");
		expect(roster).not.toContain("fixture_19");
		expect(text(unknown)).toContain(", ...");
		expect(text(results.get("good")!)).toBe("accepted:once");
		const nextResults = model.calls[1]!.context.messages.filter(message => message.role === "toolResult");
		expect(nextResults.map(message => message.toolCallId)).toEqual(["parse", "schema", "unknown", "good"]);
	});

	it("refuses a plain write without content and leaves the existing target unchanged", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-write-argument-"));
		try {
			await Bun.write(path.join(root, "keep.txt"), "must remain");
			const tool = new WriteTool({ cwd: root, settings: Settings.isolated() } as ToolSession);
			await expect(
				tool.execute("missing-content", { path: "keep.txt", i: "accidentally placed body" } as never),
			).rejects.toThrow('Retry with separate JSON fields "path" and "content"');
			expect(await Bun.file(path.join(root, "keep.txt")).text()).toBe("must remain");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
