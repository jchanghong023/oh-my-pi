import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeDevWorkbenchAssets, type DevAssetManifest } from "../src/dev-workbench/assets";
import { WorkbenchFixture, resolveInstalledDevChromium } from "../test/dev-workbench/fixture";

/** Explicit release-artifact consumer; never imported by automatic test discovery. */
function argumentsFor(argv: string[]): { npmEntry: string; binary: string; assetsManifest: string } {
	const values = new Map<string, string>();
	const allowed = new Set(["--npm-entry", "--binary", "--assets-manifest"]);
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index]!;
		const value = argv[index + 1];
		if (!allowed.has(flag) || !value || value.startsWith("--") || values.has(flag))
			throw new Error(
				"Usage: bun verify-dev-workbench-package.ts --npm-entry <path> --binary <path> --assets-manifest <path>",
			);
		values.set(flag, path.resolve(value));
	}
	const npmEntry = values.get("--npm-entry");
	const binary = values.get("--binary");
	const assetsManifest = values.get("--assets-manifest");
	if (!npmEntry || !binary || !assetsManifest)
		throw new Error("All three explicit artifact paths are required; no build or source fallback is performed");
	return { npmEntry, binary, assetsManifest };
}

async function verifyArtifact(name: string, launch: string[], expected: DevAssetManifest): Promise<void> {
	await using fixture = await WorkbenchFixture.create();
	const versionProcess = Bun.spawn([...launch, "--version"], {
		cwd: fixture.cwd,
		env: fixture.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let version: string;
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(versionProcess.stdout).text(),
			new Response(versionProcess.stderr).text(),
			versionProcess.exited,
		]);
		version = Bun.stripANSI(stdout).trim();
		if (code !== 0 || !version) throw new Error(`${name}: actual --version failed (${code}): ${stderr}`);
	} finally {
		if (versionProcess.exitCode === null) versionProcess.kill();
		await versionProcess.exited;
	}
	console.log(
		`${name}: version identity=${version}; UI sourceDigest is not proof of the entire dirty backend worktree`,
	);
	await fixture.start(launch);
	const actual = await fixture.request<DevAssetManifest>("assets-manifest");
	if (
		actual.digest !== expected.digest ||
		actual.sourceDigest !== expected.sourceDigest ||
		JSON.stringify(actual.files) !== JSON.stringify(expected.files)
	)
		throw new Error(`${name}: embedded UI payload or UI build inputs differ from the explicit generated manifest`);
	const { page } = await fixture.browser();
	const failures: string[] = [];
	page.on("pageerror", error => failures.push(String(error)));
	await page.setRequestInterception(true);
	await page.setCacheEnabled(false);
	page.on("request", request => {
		const url = new URL(request.url());
		if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
			failures.push(`External dependency: ${url}`);
			void request.abort();
		} else void request.continue();
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.waitForSelector('[data-testid="workbench"]');
	await page.waitForSelector('[data-testid="requirement-list"]');
	await page.click('[data-action="new"]');
	await page.select('[data-testid="new-source"]', "import");
	await page.click('[data-testid="new-submit"]');
	await page.waitForSelector('[data-testid="new-submit"]', { hidden: true });
	const snapshots = await fixture.list();
	if (snapshots.length !== 1 || snapshots[0]?.record.stage !== "business")
		throw new Error(`${name}: real create requirement UI failed`);
	await page.waitForSelector(`[data-requirement-id="${snapshots[0].record.requirementId}"]`);
	await page.click(`[data-requirement-id="${snapshots[0].record.requirementId}"]`);
	await page.waitForSelector('[data-testid="material-view"]');
	const stages = await page.$$eval('[data-testid="stages"] [data-stage]', elements =>
		elements.map(element => element.getAttribute("data-stage")),
	);
	if (stages.join(",") !== "business,requirements,solution,planning,executing,st,pr,testing")
		throw new Error(`${name}: complete eight-stage UI was not embedded`);
	for (const asset of expected.files) {
		const response = await fetch(new URL(asset.path.replace(/^\//u, ""), fixture.url));
		if (!response.ok) throw new Error(`${name}: embedded asset ${asset.path}: HTTP ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== asset.version)
			throw new Error(`${name}: embedded bytes differ: ${asset.path}`);
		if (!response.headers.get("content-type")?.startsWith(asset.contentType.split(";", 1)[0]!))
			throw new Error(`${name}: incorrect asset MIME: ${asset.path}`);
	}
	if (failures.length) throw new Error(`${name}: ${failures.join("\n")}`);
	if (fixture.provider.requests.length)
		throw new Error(`${name}: opening or creating imported requirement unexpectedly invoked a model`);
	console.log(`${name}: embedded browser UI verified; digest=${actual.digest}; sourceDigest=${actual.sourceDigest}`);
}

async function main(): Promise<void> {
	const args = argumentsFor(Bun.argv.slice(2));
	if (![".js", ".mjs", ".cjs"].includes(path.extname(args.npmEntry)))
		throw new Error("--npm-entry must be an actual built JavaScript CLI, not the TypeScript source entry");
	for (const artifact of [args.npmEntry, args.binary, args.assetsManifest]) {
		if (!(await fs.stat(artifact).catch(() => null))?.isFile())
			throw new Error(`Required built artifact missing: ${artifact}`);
	}
	for (const artifact of [args.npmEntry, args.binary]) {
		const hasher = new Bun.CryptoHasher("sha256");
		for await (const bytes of Bun.file(artifact).stream()) hasher.update(bytes);
		console.log(`Explicit artifact: ${artifact}; sha256=${hasher.digest("hex")}`);
	}
	await resolveInstalledDevChromium();
	const generated: unknown = JSON.parse(await fs.readFile(args.assetsManifest, "utf8"));
	const { manifest } = decodeDevWorkbenchAssets(generated);
	await verifyArtifact("npm bundle", [process.execPath, args.npmEntry], manifest);
	await verifyArtifact("standalone binary", [args.binary], manifest);
}

if (import.meta.main) await main();
