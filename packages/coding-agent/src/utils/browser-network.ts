import * as os from "node:os";

export function getWorkbenchAddresses(allowLan: boolean): string[] {
	if (!allowLan) return ["127.0.0.1"];
	const discovered = Object.values(os.networkInterfaces())
		.flatMap(entries => entries ?? [])
		.filter(entry => entry.family === "IPv4" && !entry.internal && entry.address !== "0.0.0.0")
		.map(entry => entry.address);
	return [...new Set([...discovered, "127.0.0.1"])];
}
