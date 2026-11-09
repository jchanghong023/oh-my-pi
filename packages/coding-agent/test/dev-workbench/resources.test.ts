import { expect, test } from "bun:test";
import {
	decodeDevWorkbenchAssets,
	devWorkbenchAssetDigest,
	getDevWorkbenchAsset,
	getDevWorkbenchAssetManifest,
} from "../../src/dev-workbench/assets";

test("prepared source payload serves every manifest file with actual digest and MIME", async () => {
	const manifest = await getDevWorkbenchAssetManifest();
	expect(manifest.digest).toMatch(/^[a-f0-9]{64}$/u);
	expect(manifest.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
	expect(manifest.files.length).toBeGreaterThan(1);
	for (const file of manifest.files) {
		const asset = await getDevWorkbenchAsset(file.path);
		if (!asset) throw new Error(`Manifest asset missing: ${file.path}`);
		expect(asset.contentType).toBe(file.contentType);
		expect(new Bun.CryptoHasher("sha256").update(asset.bytes).digest("hex")).toBe(file.version);
	}
	expect(devWorkbenchAssetDigest(manifest.files)).toBe(manifest.digest);
	const html = await getDevWorkbenchAsset("/");
	if (!html) throw new Error("Workbench HTML missing");
	expect(html.contentType).toContain("text/html");
	const text = new TextDecoder().decode(html.bytes);
	const tags = [...text.matchAll(/<(script|link)\b([^>]*)>/giu)].map(match => ({
		name: match[1]!.toLowerCase(),
		attributes: new Map(
			[...match[2]!.matchAll(/([^\s=/"'<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)].map(
				attribute => [attribute[1]!.toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? ""],
			),
		),
	}));
	const scripts = tags.filter(tag => tag.name === "script");
	expect(scripts).toHaveLength(1);
	const script = scripts[0]!;
	expect(["", "text/javascript", "application/javascript"]).toContain(
		(script.attributes.get("type") ?? "").trim().toLowerCase(),
	);
	expect(script.attributes.has("nomodule")).toBe(false);
	expect(script.attributes.get("src")).toBeTruthy();
	const stylesheets = tags.filter(
		tag =>
			tag.name === "link" && (tag.attributes.get("rel") ?? "").toLowerCase().split(/\s+/u).includes("stylesheet"),
	);
	expect(stylesheets.length).toBeGreaterThan(0);
	for (const stylesheet of stylesheets) {
		expect(stylesheet.attributes.get("href")).toBeTruthy();
	}

	const base = new URL("http://127.0.0.1/");
	const references = [...text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/giu)].map(match => match[1]!);
	const referencedPaths = new Set<string>(["/index.html"]);
	for (const reference of references) {
		const url = new URL(reference, base);
		expect(url.origin).toBe(base.origin);
		expect(reference).not.toMatch(/^(?:[a-z][a-z\d+.-]*:)?\/\//iu);
		referencedPaths.add(url.pathname);
		expect(manifest.files.some(file => file.path === url.pathname)).toBe(true);
		expect(await getDevWorkbenchAsset(url.pathname)).not.toBeNull();
	}
	// Every packaged resource must be reachable from the delivered page, not an orphan module chunk.
	expect([...referencedPaths].sort()).toEqual(manifest.files.map(file => file.path).sort());
	const scriptPath = new URL(script.attributes.get("src")!, base).pathname;
	expect(manifest.files.filter(file => file.contentType.startsWith("text/javascript")).map(file => file.path)).toEqual(
		[scriptPath],
	);
	const javascript = await getDevWorkbenchAsset(scriptPath);
	if (!javascript) throw new Error(`Workbench script missing: ${scriptPath}`);
	expect(javascript.contentType).toContain("text/javascript");
	for (const stylesheet of stylesheets) {
		const stylesheetPath = new URL(stylesheet.attributes.get("href")!, base).pathname;
		const css = await getDevWorkbenchAsset(stylesheetPath);
		if (!css) throw new Error(`Workbench stylesheet missing: ${stylesheetPath}`);
		expect(css.contentType).toContain("text/css");
	}
	expect(await getDevWorkbenchAsset("/missing-ui.js")).toBeNull();
	expect(await getDevWorkbenchAsset("/../../package.json")).toBeNull();
});

test("isolated corrupt or incomplete generated payloads fail rather than serving a demo", () => {
	for (const value of [
		null,
		{},
		{ schemaVersion: 1, manifest: { digest: "bad", sourceDigest: "bad", files: [] }, files: [] },
	]) {
		expect(() => decodeDevWorkbenchAssets(value)).toThrow();
	}
});
