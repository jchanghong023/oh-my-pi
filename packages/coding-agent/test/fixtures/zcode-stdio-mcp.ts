/** Real newline-framed MCP peer using Bun pipe streams on every platform. */
import { isRecord, readJsonl } from "@oh-my-pi/pi-utils";

const name = Bun.env.SRV_NAME ?? "srv";
const startupDelayMs = Number(Bun.env.DELAY_STARTUP ?? 0);
const marker = `${name}_marker`;
const output = Bun.stdout.writer();

try {
	for await (const request of readJsonl<unknown>(Bun.stdin.stream())) {
		if (!isRecord(request) || request.id === undefined) continue;
		let result: unknown;
		let error: { code: number; message: string } | undefined;
		switch (request.method) {
			case "initialize":
				if (Bun.env.STARTUP_NOTIFY_URL) await fetch(Bun.env.STARTUP_NOTIFY_URL);
				if (startupDelayMs > 0) await Bun.sleep(startupDelayMs);
				result = {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name, version: "1.0.0" },
				};
				break;
			case "tools/list":
				result = {
					tools: [
						{
							name: marker,
							description: `Return the ${name} marker.`,
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
				};
				break;
			case "tools/call":
				if (isRecord(request.params) && request.params.name === marker) {
					result = { content: [{ type: "text", text: `MARKER_OK::${name}` }] };
				} else {
					error = { code: -32602, message: "Unknown marker tool" };
				}
				break;
			default:
				error = { code: -32601, message: "Method not found" };
		}
		output.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) })}\n`);
		await output.flush();
	}
} finally {
	await output.end();
}
