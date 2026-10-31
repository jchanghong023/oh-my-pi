import { existsSync } from "node:fs";
import * as path from "node:path";

/** Recognize both git worktrees and source archives containing the fork. */
export function isOpenWikiSourceCheckout(root: string): boolean {
	return existsSync(path.join(root, ".git")) || existsSync(path.join(root, "vendor/openwiki/package.json"));
}

export const openWikiLicensedPackages = [
	"@langchain/core",
	"@langchain/openai",
	"deepagents",
	"ink",
	"jsdom",
	"langchain",
	"marked",
	"posthog-node",
	"react",
	"yaml",
	"zod",
	"force-graph",
	"openwiki-marked",
	"dompurify",
	"mermaid",
];

/** Resolve from the importing package, including nested Bun node_modules layouts. */
export function openWikiPackageDirectory(name: string, from: string): string {
	let dir = from;
	for (;;) {
		const candidate = path.join(dir, "node_modules", name);
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) throw new Error(`Cannot resolve ${name} from ${from}; run bun install`);
		dir = parent;
	}
}
