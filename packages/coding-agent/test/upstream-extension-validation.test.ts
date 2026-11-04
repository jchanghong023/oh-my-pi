import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { CustomToolAdapter } from "../src/extensibility/custom-tools/wrapper";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { RegisteredToolAdapter } from "../src/extensibility/extensions/wrapper";

// Both extension APIs must use ordinary agent validation, even if a JavaScript
// extension carries the removed lenient option from an older definition.
describe("upstream extension argument validation", () => {
	it.each(["registered", "custom"] as const)(
		"rejects invalid %s arguments before execution and accepts the next valid call",
		async kind => {
			const executions: unknown[] = [];
			const parameters = type({ mode: "'safe' | 'inspect'", value: "string" });
			const definition = {
				name: "extension_probe",
				label: "Extension probe",
				description: "A schema-checked extension tool",
				parameters,
				lenientArgValidation: true,
				async execute(_id: string, args: typeof parameters.infer) {
					executions.push(args);
					return { content: [{ type: "text" as const, text: `${args.mode}:${args.value}` }] };
				},
			};
			const context = {} as CustomToolContext;
			const runner = {
				getNativeDelegationGuidance: () => undefined,
				createContext: () => context,
			} as unknown as ExtensionRunner;
			const tool =
				kind === "custom"
					? new CustomToolAdapter(definition, () => context)
					: new RegisteredToolAdapter(
							{
								definition,
								extensionPath: "<validation-fixture>",
								sourceInfo: {
									path: "<validation-fixture>",
									source: "extension",
									scope: "temporary",
									origin: "top-level",
								},
							},
							runner,
						);
			const mock = createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								id: "invalid-extension-call",
								name: tool.name,
								arguments: { mode: "destroy", value: "must not execute" },
							},
						],
					},
					{
						content: [
							{
								type: "toolCall",
								id: "valid-extension-call",
								name: tool.name,
								arguments: { mode: "safe", value: "accepted" },
							},
						],
					},
					{ content: ["finished"] },
				],
			});
			const agent = new Agent({ initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream });
			await agent.prompt("Run the extension probe.");
			const results = agent.state.messages.filter(message => message.role === "toolResult");
			expect(results).toHaveLength(2);
			expect(results[0]).toMatchObject({ toolCallId: "invalid-extension-call", isError: true });
			expect(results[0]?.content).toEqual([
				expect.objectContaining({ type: "text", text: expect.stringContaining("mode") }),
			]);
			expect(results[1]).toMatchObject({
				toolCallId: "valid-extension-call",
				isError: false,
				content: [{ type: "text", text: "safe:accepted" }],
			});
			expect(executions).toEqual([{ mode: "safe", value: "accepted" }]);
		},
	);
});
