import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeEmbeddedArchive, extractEmbeddedArchive } from "@oh-my-pi/pi-utils/embedded-archive";
import { decodeAIReqWorkbenchArchive, type AIReqAssetManifest } from "../src/aireq-workbench/assets";
import { chromiumExecutableProbeForTest, systemChromiumCandidatesForTest } from "../src/tools/browser/launch";
import { WorkflowConsumerFixture, withWorkflowChromium } from "../test/aireq-workbench/workflow-fixture";

/** Explicit release-artifact consumer; never imported by automatic test discovery. */
function argumentsFor(argv: string[]): { npmEntry: string; binary: string; assetsManifest: string } {
	const values = new Map<string, string>();
	const allowed = new Set(["--npm-entry", "--binary", "--assets-manifest"]);
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index]!;
		const value = argv[index + 1];
		if (!allowed.has(flag) || !value || value.startsWith("--") || values.has(flag))
			throw new Error(
				"Usage: bun verify-aireq-workbench-package.ts --npm-entry <path> --binary <path> --assets-manifest <path>",
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

async function installedChromium(): Promise<string> {
	const explicit = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
	for (const candidate of explicit ? [explicit] : systemChromiumCandidatesForTest()) {
		if ((await fs.stat(candidate).catch(() => null))?.isFile() && (await chromiumExecutableProbeForTest(candidate)))
			return candidate;
	}
	throw new Error("Packaged AIReq verification requires installed Chromium; no browser download is performed");
}

async function verifyArtifact(
	name: string,
	launch: string[],
	expected: AIReqAssetManifest,
	chromium: string,
): Promise<void> {
	await using fixture = await WorkflowConsumerFixture.create();
	const versionProcess = Bun.spawn([...launch, "--version"], {
		cwd: fixture.project,
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
	const process = await fixture.start(launch);
	const manifestResponse = await process.request("api/assets-manifest");
	if (!manifestResponse.ok) throw new Error(`${name}: asset manifest HTTP ${manifestResponse.status}`);
	const actual = (await manifestResponse.json()) as AIReqAssetManifest;
	if (
		actual.digest !== expected.digest ||
		actual.sourceDigest !== expected.sourceDigest ||
		JSON.stringify(actual.files) !== JSON.stringify(expected.files)
	)
		throw new Error(`${name}: embedded UI payload or UI build inputs differ from the explicit generated manifest`);
	const initial = await process.view();
	const project = initial.projects.find(project => path.resolve(project.root) === path.resolve(fixture.project));
	if (!project) throw new Error(`${name}: isolated project was not registered`);
	const release = await process.command({
		type: "createRelease",
		operationId: crypto.randomUUID(),
		expectedRevision: initial.revision,
		projectId: project.id,
		title: "Packaged AIReq smoke",
	});
	if (!release.response.ok || release.result.status !== "completed")
		throw new Error(`${name}: real release setup failed: ${JSON.stringify(release.result)}`);
	const failures: string[] = [];
	await withWorkflowChromium(chromium, async browser => {
		const page = await browser.newPage();
		page.on("pageerror", error => failures.push(String(error)));
		page.on("requestfailed", request =>
			failures.push(`Request failed: ${request.url()} ${request.failure()?.errorText}`),
		);
		await page.setRequestInterception(true);
		await page.setCacheEnabled(false);
		const base = new URL(process.url);
		page.on("request", request => {
			const url = new URL(request.url());
			if (["data:", "blob:"].includes(url.protocol)) void request.continue();
			else if (url.host !== base.host || !url.pathname.startsWith(base.pathname)) {
				failures.push(`Dependency escapes isolated AIReq origin/capability: ${url}`);
				void request.abort();
			} else void request.continue();
		});
		page.on("response", response => {
			if (response.status() >= 400) failures.push(`HTTP ${response.status()}: ${response.url()}`);
		});
		await page.goto(process.url, { waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-testid="aireq-workflow-root"]');
		await page.waitForSelector('[data-testid="project-select"]');
		await page.waitForSelector('[data-testid="release-select"]');
		await page.waitForSelector('[data-testid="import-package"]');
		await page.waitForSelector('[data-testid="settings"]');
		await page.waitForSelector('[data-testid="new-browser"]:not([disabled])');
		await page.click('[data-testid="new-browser"]');
		await page.waitForSelector('[data-aireq-draft="true"][data-ir-id]');
		const view = await process.view(project.id);
		const draft = view.drafts[0];
		if (view.drafts.length !== 1 || !draft || draft.origin !== "browser" || draft.worktree || view.srs.length)
			throw new Error(`${name}: browser drafting created incorrect workflow or Git state`);
		await page.waitForSelector(`[data-aireq-draft="true"][data-ir-id="${draft.id}"]`);
		await page.waitForSelector('[data-testid="materials-pane"]');
		await page.waitForSelector('[data-testid="material-menu"]');
		if ((await page.$$('[data-testid^="stage-"]')).length)
			throw new Error(`${name}: an IR incorrectly exposes SR development phases`);
		for (const selector of ["requirement-confirm", "requirement-download"])
			if (!(await page.$eval(`[data-testid="${selector}"]`, element => element.hasAttribute("disabled"))))
				throw new Error(`${name}: empty browser requirements unexpectedly enable ${selector}`);
		// Browser disposal intentionally aborts any in-flight periodic refresh.
		page.removeAllListeners("requestfailed");
	});
	for (const asset of expected.files) {
		const response = await process.request(asset.path.replace(/^\//u, ""));
		if (!response.ok) throw new Error(`${name}: embedded asset ${asset.path}: HTTP ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== asset.version)
			throw new Error(`${name}: embedded bytes differ: ${asset.path}`);
		if (response.headers.get("content-type") !== asset.contentType)
			throw new Error(`${name}: incorrect asset MIME: ${asset.path}`);
		if (response.headers.get("x-content-type-options") !== "nosniff")
			throw new Error(`${name}: asset MIME sniffing was not disabled: ${asset.path}`);
	}
	const missing = await process.request("assets/missing-packaged-resource.js");
	if (missing.status !== 404) throw new Error(`${name}: missing resource returned ${missing.status} instead of 404`);
	if (failures.length) throw new Error(`${name}: ${failures.join("\n")}`);
	if (fixture.provider.requests.length)
		throw new Error(`${name}: opening or drafting browser requirements unexpectedly invoked a model`);
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
	const chromium = await installedChromium();
	const archive = decodeEmbeddedArchive(await fs.readFile(args.assetsManifest, "utf8"));
	if (!archive) throw new Error(`Generated AIReq workbench archive is empty or corrupt: ${args.assetsManifest}`);
	const { manifest } = await decodeAIReqWorkbenchArchive(await extractEmbeddedArchive(archive));
	await verifyArtifact("npm bundle", [process.execPath, args.npmEntry], manifest, chromium);
	await verifyArtifact("standalone binary", [args.binary], manifest, chromium);
}

if (import.meta.main) await main();
