import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import manifest from "../package.json" with { type: "json" };

const packageRoot = path.resolve(import.meta.dir, "..");

/**
 * Regression for #14027: Bun prefers JavaScript siblings over TypeScript
 * when resolving the published source from `node_modules`. An intentional
 * replacement is valid only if the TypeScript variant is excluded from the
 * package (as for the developer-test-agent shim); all shipped TS modules
 * must still resolve to themselves.
 */
test("every src module resolves to itself when the package is installed under node_modules", async () => {
	using tempDir = TempDir.createSync("@omp-installed-source-resolution-");
	const installedRoot = tempDir.join("node_modules", "@oh-my-pi", "pi-coding-agent");
	await fs.mkdir(path.dirname(installedRoot), { recursive: true });
	await fs.symlink(packageRoot, installedRoot, "dir");

	const excluded = new Set(manifest.files.filter(entry => entry.startsWith("!")).map(entry => entry.slice(1)));
	const misresolved: string[] = [];
	for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: path.join(packageRoot, "src") })) {
		const source = `src/${rel.replaceAll("\\", "/")}`;
		const specifier = `./${source.slice(0, source.lastIndexOf("."))}`;
		const expected = excluded.has(source) ? `${specifier.slice(2)}.js` : source;
		const resolved = Bun.resolveSync(specifier, installedRoot);
		if (excluded.has(expected) || resolved !== path.join(packageRoot, expected)) {
			misresolved.push(`${specifier} -> ${resolved} (expected ${expected})`);
		}
	}

	expect(misresolved).toEqual([]);
});
