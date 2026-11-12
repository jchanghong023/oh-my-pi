#!/usr/bin/env bun
// Opt-in real AIReq acceptance. Never build, install, download, create platform PRs, or clean a user repository.
// bun scripts/aireq-development-e2e.ts --browser both --root F:/testgithub/test --chrome <installed> --firefox <installed> --merge-receipts <external-directory>
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import type { Browser, Page, KeyInput, ElementHandle } from "puppeteer-core";
import {
	closeLaunchedBrowser,
	launchHeadlessBrowser,
	removeUserDataDir,
} from "../packages/coding-agent/src/tools/browser/launch";
import { decodeAIReqWorkbenchAssets } from "../packages/coding-agent/src/aireq-workbench/assets";
import type { AIReqWorkflowView } from "../packages/coding-agent/src/aireq-workbench/workflow-types";
import type { SessionEntry } from "../packages/coding-agent/src/session/session-entries";
import {
	isolatedWorkflowEnvironment,
	pollWorkflow,
	workflowGit,
	workflowRedactor,
	WorkflowConsumerProcess,
	writeWorkflowProfile,
	WORKFLOW_ROLES,
} from "../packages/coding-agent/test/aireq-workbench/workflow-fixture";
import {
	DEV_JOURNEY_STEPS,
	DEV_REAL_BUSINESS,
	DEV_VERSION_BUSINESS,
	assertMergeManifest,
	runAIReqJourney,
	type AIReqJourneyEvidence,
	type AIReqManualMergeReceipt,
	type AIReqMergeRequest,
} from "./aireq-development-e2e-journey";
import {
	PlatformPrerequisiteError,
	withFirefoxBrowser,
	type DevelopmentBrowser,
	type DevelopmentPage,
} from "./webgui-platform-smoke";

const repository = path.resolve(import.meta.dir, "..");
const MODEL = "opencode-go/beam-free";
const digest = (bytes: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export interface AIReqE2EOptions {
	browser: "chrome" | "firefox" | "both";
	root: string;
	chrome?: string;
	firefox?: string;
	headless?: boolean;
	evidenceDir?: string;
	/** Existing generated copied-frontend payload, never a aireq-server/source fallback. */
	assetsPayload?: string;
	/** External human/authorized CLI writes receipts here; this runner invokes no PR platform. */
	mergeReceipts?: string;
	/** Default true: real Git against a retained local bare test remote, never production default. */
	controlledGit?: boolean;
	controlRemote?: string;
	timeoutMs?: number;
	manualTimeoutMs?: number;
}
export interface AIReqE2EAuthorization {
	credential?: string;
}
interface BrowserReport {
	browser: "chrome" | "firefox";
	status: "passed" | "failed" | "blocked";
	steps: AIReqJourneyEvidence[];
	identity?: Record<string, unknown>;
	productionResources?: { path: string; sha256: string; size: number }[];
	error?: string;
	cleanup?: { nativeExited: boolean; browserExited: boolean; preservedUserRoot: boolean };
}
interface RootSnapshot {
	head: string;
	branch: string;
	index: string;
	status: string;
	files: Record<string, string>;
}
async function snapshotUserRoot(root: string): Promise<RootSnapshot> {
	const files: Record<string, string> = {};
	async function visit(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (entry.name === ".git") continue;
			const file = path.join(directory, entry.name);
			const relative = path.relative(root, file).replaceAll("\\", "/");
			if (entry.isSymbolicLink()) files[relative] = `symlink:${await fs.readlink(file)}`;
			else if (entry.isDirectory()) await visit(file);
			else if (entry.isFile()) files[relative] = digest(await fs.readFile(file));
		}
	}
	await visit(root);
	return {
		head: await workflowGit(root, ["rev-parse", "HEAD"]),
		branch: await workflowGit(root, ["symbolic-ref", "--short", "HEAD"]),
		index: await workflowGit(root, ["ls-files", "--stage", "-z"]),
		status: await workflowGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
		files,
	};
}
async function assertUserRootPreserved(root: string, before: RootSnapshot): Promise<void> {
	const after = await snapshotUserRoot(root);
	if (before.head !== after.head || before.branch !== after.branch || before.index !== after.index)
		throw new Error("Acceptance changed the existing user checkout HEAD, branch or index");
	for (const [file, hash] of Object.entries(before.files))
		if (after.files[file] !== hash) throw new Error(`Acceptance changed/deleted preexisting user bytes: ${file}`);
	const additions = Object.keys(after.files).filter(file => !(file in before.files));
	if (additions.length)
		throw new Error(
			`Acceptance wrote files into the existing user checkout instead of an isolated worktree: ${additions.join(", ")}`,
		);
}
async function installed(file: string | undefined, name: string): Promise<string> {
	if (
		!file ||
		!(await fs.stat(file).then(
			value => value.isFile(),
			() => false,
		))
	)
		throw new PlatformPrerequisiteError(
			name,
			`Installed ${name} executable required; no browser or driver is downloaded`,
		);
	return path.resolve(file);
}

/** Native Puppeteer actions; evaluate is observations only. Central launcher remains unchanged. */
export async function chromeDevelopmentPage(page: Page): Promise<DevelopmentPage> {
	const input = '[data-testid="v4-composer-input"][contenteditable="true"]';
	return {
		navigate: async url => {
			await page.goto(url, { waitUntil: "domcontentloaded" });
		},
		reload: async () => {
			await page.reload({ waitUntil: "domcontentloaded" });
		},
		evaluate: async <T>(expression: string) => page.evaluate(expression) as Promise<T>,
		click: async value => {
			await page.click(value);
		},
		hover: async value => {
			await page.hover(value);
		},
		type: async (value, text) => {
			await page.type(value, text);
		},
		clear: async value => {
			await page.click(value);
			await page.keyboard.down("Control");
			await page.keyboard.press("A");
			await page.keyboard.up("Control");
			await page.keyboard.press("Backspace");
		},
		press: async (value, key) => {
			await page.focus(value);
			await page.keyboard.press(key as KeyInput);
		},
		typeDraft: async text => {
			await page.type(input, text);
		},
		clearDraft: async () => {
			await page.click(input);
			await page.keyboard.down("Control");
			await page.keyboard.press("A");
			await page.keyboard.up("Control");
			await page.keyboard.press("Backspace");
		},
		upload: async (value, files) => {
			const element = await page.$(value);
			if (!element) throw new Error(`Missing upload control: ${value}`);
			await (element as ElementHandle<HTMLInputElement>).uploadFile(...files);
		},
		screenshot: async file => {
			await page.screenshot({ path: file, fullPage: true });
		},
		draw: async (value, points) => {
			const element = await page.$(value);
			const box = await element?.boundingBox();
			if (!box || points.length < 2) throw new Error("Visible drawing canvas and two points required");
			await page.mouse.move(box.x + points[0].x, box.y + points[0].y);
			await page.mouse.down();
			try {
				for (const point of points.slice(1)) await page.mouse.move(box.x + point.x, box.y + point.y);
			} finally {
				await page.mouse.up();
			}
		},
		close: async () => {
			await page.close();
		},
	};
}

interface ControlledGit {
	remote: string;
	helper: string;
	originalRefs: Map<string, string>;
	defaultBranch: string;
	defaultCommit: string;
	fetchHeadPath: string;
	fetchHead?: Buffer;
}
async function remoteTrackingRefs(root: string, env: Record<string, string>): Promise<Map<string, string>> {
	const source = await workflowGit(
		root,
		["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/remotes/origin/"],
		env,
	);
	return new Map(
		source
			.split(/\r?\n/u)
			.filter(Boolean)
			.map(line => {
				const [ref, commit] = line.split("\t");
				return [ref, commit];
			}),
	);
}
async function prepareControlledGit(
	root: string,
	directory: string,
	runId: string,
	env: Record<string, string>,
	suppliedRemote?: string,
): Promise<ControlledGit> {
	const originalRefs = await remoteTrackingRefs(root, env);
	const commonDir = await workflowGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], env);
	const fetchHeadPath = await workflowGit(
		root,
		["rev-parse", "--path-format=absolute", "--git-path", "FETCH_HEAD"],
		env,
	);
	const fetchHeadStat = await fs.lstat(fetchHeadPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (fetchHeadStat?.isSymbolicLink())
		throw new Error("Existing FETCH_HEAD is an alias; acceptance will not mutate it");
	const fetchHead = await fs.readFile(fetchHeadPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	const sourceRemote = await workflowGit(root, ["remote", "get-url", "origin"], env);
	if (/^[a-z]+:\/\//iu.test(sourceRemote)) {
		const url = new URL(sourceRemote);
		if (url.username || url.password || url.search)
			throw new Error("Acceptance does not copy credential-bearing Git URLs");
	}
	const advertisement = await workflowGit(root, ["ls-remote", "--symref", "origin", "HEAD"], env);
	const defaultBranch = /^ref: refs\/heads\/([^\t\n]+)\tHEAD$/mu.exec(advertisement)?.[1];
	const initialDefaultCommit = /^([a-f0-9]{40,64})\tHEAD$/mu.exec(advertisement)?.[1];
	if (!defaultBranch || !initialDefaultCommit)
		throw new Error("Actual origin did not advertise an unambiguous default branch and commit");
	// Stable effective URL keeps repository identity reusable across isolated browser runs.
	const remote = path.resolve(
		suppliedRemote ?? path.join(os.tmpdir(), `omp-aireq-controlled-${digest(commonDir).slice(0, 24)}.git`),
	);
	const relative = path.relative(root, remote);
	if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
		throw new Error("Controlled remote must be outside the existing user checkout");
	const markerFile = path.join(remote, "omp-aireq-acceptance-control.json");
	const exists = await fs.lstat(remote).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (exists) {
		if (!exists.isDirectory() || exists.isSymbolicLink())
			throw new Error("Controlled remote is not a real owned directory");
		const marker = JSON.parse(await fs.readFile(markerFile, "utf8"));
		if (
			marker.format !== "omp-aireq-acceptance-control-v1" ||
			marker.commonDir !== commonDir ||
			marker.defaultBranch !== defaultBranch ||
			(await workflowGit(remote, ["rev-parse", "--is-bare-repository"], env)) !== "true"
		)
			throw new Error("Refusing to reuse an unrelated or incompatible control remote");
	} else {
		await fs.mkdir(path.dirname(remote), { recursive: true });
		await workflowGit(directory, ["clone", "--bare", "--no-hardlinks", root, remote], env);
		await workflowGit(remote, ["fetch", "--no-tags", sourceRemote, `refs/heads/${defaultBranch}`], env);
		await workflowGit(remote, ["update-ref", `refs/heads/${defaultBranch}`, initialDefaultCommit], env);
		await workflowGit(remote, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], env);
		await fs.writeFile(
			markerFile,
			JSON.stringify({ format: "omp-aireq-acceptance-control-v1", commonDir, defaultBranch, initialDefaultCommit }),
			{ flag: "wx" },
		);
	}
	const defaultCommit = await workflowGit(remote, ["rev-parse", `refs/heads/${defaultBranch}`], env);
	// Effective child-only Git config. Never edit the existing project's .git/config.
	env.GIT_CONFIG_COUNT = "2";
	env.GIT_CONFIG_KEY_0 = "remote.origin.url";
	env.GIT_CONFIG_VALUE_0 = remote;
	env.GIT_CONFIG_KEY_1 = "remote.origin.pushurl";
	env.GIT_CONFIG_VALUE_1 = remote;
	if (
		(await workflowGit(root, ["remote", "get-url", "origin"], env)) !== remote ||
		(await workflowGit(root, ["remote", "get-url", "--push", "origin"], env)) !== remote
	)
		throw new Error("Child Git remote override is not effective; refusing any publish");
	const probe = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`import {requireGit} from "@oh-my-pi/pi-natives/vcs"; const repo=requireGit(process.env.OMP_AIREQ_PROBE_ROOT); const url=await repo.remoteUrl("origin"); const head=await repo.remoteDefaultBranch("origin"); if(url!==process.env.OMP_AIREQ_PROBE_REMOTE||head.branch!==process.env.OMP_AIREQ_PROBE_BRANCH)throw new Error("Native effective remote/default mismatch"); console.log("native-controlled-remote-confirmed");`,
		],
		{
			cwd: repository,
			env: { ...env, OMP_AIREQ_PROBE_ROOT: root, OMP_AIREQ_PROBE_REMOTE: remote, OMP_AIREQ_PROBE_BRANCH: defaultBranch },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [probeOutput, probeError, probeCode] = await Promise.all([
		new Response(probe.stdout).text(),
		new Response(probe.stderr).text(),
		probe.exited,
	]);
	await fs.writeFile(
		path.join(directory, "native-vcs-overlay-probe.json"),
		JSON.stringify(
			{
				exitCode: probeCode,
				stdout: probeOutput,
				stderr: probeError,
				credentialEnvironment: "not inherited by this Git-only probe",
			},
			null,
			2,
		),
	);
	if (probeCode !== 0 || !probeOutput.includes("native-controlled-remote-confirmed"))
		throw new PlatformPrerequisiteError(
			"native-git-config-overlay",
			`Native VCS did not confirm the controlled remote; refusing publish. ${probeError}`,
		);
	const helperRepository = path.join(directory, "merge-helper.git");
	const helper = path.join(directory, "merge-helper");
	await workflowGit(directory, ["clone", "--bare", "--no-hardlinks", remote, helperRepository], env);
	await workflowGit(
		helperRepository,
		["worktree", "add", "-b", `omp-aireq-acceptance/${runId}/merge-helper`, helper, defaultCommit],
		env,
	);
	return { remote, helper, originalRefs, defaultBranch, defaultCommit, fetchHeadPath, fetchHead };
}
async function controlledManualMerge(
	control: ControlledGit,
	request: AIReqMergeRequest,
	env: Record<string, string>,
	evidence: string,
): Promise<AIReqManualMergeReceipt> {
	if (request.targetBranch !== control.defaultBranch)
		throw new Error("Controlled merge target differs from actual repository default branch");
	const sourceCommit = await workflowGit(request.worktree, ["rev-parse", "HEAD"], env);
	const sourceRef = `refs/heads/${request.sourceBranch}`;
	if ((await workflowGit(control.remote, ["rev-parse", sourceRef], env)) !== sourceCommit)
		throw new Error("Manual PR registration requires the actual pushed source HEAD");
	await assertMergeManifest(request.worktree, sourceCommit, request);
	await workflowGit(
		control.helper,
		[
			"fetch",
			control.remote,
			`refs/heads/${control.defaultBranch}:refs/remotes/origin/${control.defaultBranch}`,
			`${sourceRef}:refs/remotes/origin/${request.sourceBranch}`,
		],
		env,
	);
	await workflowGit(control.helper, ["merge", "--ff-only", `refs/remotes/origin/${control.defaultBranch}`], env);
	const log = await workflowGit(
		control.helper,
		[
			"merge",
			"--no-ff",
			"-m",
			`Controlled AIReq acceptance ${request.kind} ${request.irId}`,
			`refs/remotes/origin/${request.sourceBranch}`,
		],
		env,
	);
	const commit = await workflowGit(control.helper, ["rev-parse", "HEAD"], env);
	await assertMergeManifest(control.helper, commit, request);
	// This explicit test action can push ONLY the owned local bare repository.
	if (path.resolve(control.remote) === path.resolve(request.root) || !path.basename(control.remote).endsWith(".git"))
		throw new Error("Controlled merge remote is not an owned bare test repository");
	await workflowGit(control.helper, ["push", control.remote, `HEAD:refs/heads/${control.defaultBranch}`], env);
	const receipt: AIReqManualMergeReceipt = {
		kind: request.kind,
		irId: request.irId,
		srId: request.srId,
		commit,
		targetBranch: request.targetBranch,
		platformVerified: false,
		mode: "controlled-test-scope",
		prUrl: `https://controlled-test.invalid/${request.kind}/${request.irId}/${request.srId ?? "group"}`,
	};
	await fs.writeFile(
		path.join(evidence, `${request.kind}-${request.irId}.manual-git.json`),
		JSON.stringify(
			{
				request,
				receipt,
				sourceCommit,
				mergeOutput: log,
				disclosure:
					"Local controlled Git test; not a company PR, platform review or approval. Production default branch was never pushed.",
			},
			null,
			2,
		),
	);
	return receipt;
}
async function restoreControlledTracking(
	root: string,
	control: ControlledGit,
	env: Record<string, string>,
): Promise<void> {
	const current = await remoteTrackingRefs(root, env);
	for (const [ref, commit] of current) {
		if (ref.endsWith("/HEAD") || control.originalRefs.get(ref) === commit) continue;
		const branch = ref.slice("refs/remotes/origin/".length);
		if ((await workflowGit(control.remote, ["rev-parse", `refs/heads/${branch}`], env)) !== commit)
			throw new Error(`Ref changed outside owned acceptance remote; refusing restore: ${ref}`);
		const before = control.originalRefs.get(ref);
		if (before) await workflowGit(root, ["update-ref", ref, before, commit], env);
		else await workflowGit(root, ["update-ref", "-d", ref, commit], env);
	}
	const restored = await remoteTrackingRefs(root, env);
	for (const [ref, commit] of control.originalRefs)
		if (restored.get(ref) !== commit) throw new Error(`Original remote-tracking ref was not restored: ${ref}`);
	const fetchStat = await fs.lstat(control.fetchHeadPath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
	if (fetchStat?.isSymbolicLink()) throw new Error("FETCH_HEAD became an alias; refusing metadata restore");
	const fetched = fetchStat ? await fs.readFile(control.fetchHeadPath) : undefined;
	if (!fetched && control.fetchHead) throw new Error("Preexisting FETCH_HEAD disappeared outside owned fetch work");
	if (fetched && (!control.fetchHead || !fetched.equals(control.fetchHead))) {
		const normalized = fetched.toString("utf8").replaceAll("\\", "/").toLowerCase();
		if (!normalized.includes(control.remote.replaceAll("\\", "/").toLowerCase()))
			throw new Error("FETCH_HEAD changed outside the owned control remote; refusing restore");
		if (control.fetchHead) await fs.writeFile(control.fetchHeadPath, control.fetchHead);
		else await fs.unlink(control.fetchHeadPath);
	}
}
async function chromiumEnvironment(root: string): Promise<Record<string, string>> {
	const env = isolatedWorkflowEnvironment(root);
	// Fresh userDataDir is isolated by the centralized launcher. Preserve Windows known folders.
	if (process.platform === "win32")
		for (const name of [
			"USERPROFILE",
			"APPDATA",
			"LOCALAPPDATA",
			"ProgramFiles",
			"ProgramFiles(x86)",
			"ProgramData",
			"HOMEDRIVE",
			"HOMEPATH",
		])
			if (process.env[name]) env[name] = process.env[name]!;
	return env;
}
export async function withAIReqChrome<T>(
	executable: string,
	root: string,
	downloads: string,
	run: (browser: DevelopmentBrowser) => Promise<T>,
	headless = true,
): Promise<T> {
	const launched = await launchHeadlessBrowser({
		executablePath: executable,
		headless,
		env: await chromiumEnvironment(root),
	});
	const browser: Browser = launched.browser;
	try {
		const session = await browser.target().createCDPSession();
		await session.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
		const pages = await browser.pages();
		const page = pages[0] ?? (await browser.newPage());
		return await run({
			identity: { browserName: "chrome", browserVersion: await browser.version(), freshNativeProfile: true },
			page: await chromeDevelopmentPage(page),
			newPage: async () => chromeDevelopmentPage(await browser.newPage()),
			pages: async () => Promise.all((await browser.pages()).map(chromeDevelopmentPage)),
		});
	} finally {
		await closeLaunchedBrowser(browser, { strict: true });
		if (launched.userDataDir) await removeUserDataDir(launched.userDataDir, { strict: true });
	}
}

/** External PR declaration is deliberately separate from the later genuine merge receipt. */
async function manualCodePrUrl(
	directory: string,
	request: AIReqMergeRequest,
	timeout: number,
	redact: (text: string) => string,
): Promise<string> {
	await fs.mkdir(directory, { recursive: true });
	const key = `${request.kind}-${request.irId}-${request.srId ?? "group"}`;
	const requestFile = path.join(directory, `${key}.pr-request.json`);
	const declarationFile = path.join(directory, `${key}.pr-declaration.json`);
	await fs.writeFile(
		requestFile,
		redact(
			JSON.stringify(
				{
					...request,
					instructions:
						"External authorized PR submission declaration only: create/register the code PR for this pushed source and target, but DO NOT MERGE. A bounded explicitly authorized same-requirement repair and resubmission must happen first. Write the matching irId, srId, sourceBranch, targetBranch, prUrl and platformVerified:false to the pr-declaration file. This is no platform review/approval receipt. Preserve original user branch/files/.omp; no credentials or capability URLs.",
				},
				null,
				2,
			),
		),
		{ flag: "wx" },
	);
	const declaration = await pollWorkflow(
		async () => {
			try {
				return JSON.parse(await fs.readFile(declarationFile, "utf8")) as {
					irId: string;
					srId: string;
					sourceBranch: string;
					targetBranch: string;
					prUrl: string;
					platformVerified: false;
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		Boolean,
		`Explicit external unmerged code PR declaration (${declarationFile})`,
		timeout,
	);
	if (
		!declaration ||
		declaration.irId !== request.irId ||
		declaration.srId !== request.srId ||
		declaration.sourceBranch !== request.sourceBranch ||
		declaration.targetBranch !== request.targetBranch ||
		declaration.platformVerified !== false
	)
		throw new Error("External code PR declaration does not match the exact unmerged source and target");
	const url = new URL(declaration.prUrl);
	if (
		!/^https?:$/u.test(url.protocol) ||
		url.username ||
		url.password ||
		/token|key|secret|authorization/iu.test(url.search)
	)
		throw new Error("Manual PR URL must be an ordinary HTTP(S) URL with no credential material");
	return declaration.prUrl;
}

async function manualReceipt(
	directory: string,
	request: AIReqMergeRequest,
	timeout: number,
	redact: (text: string) => string,
): Promise<AIReqManualMergeReceipt> {
	await fs.mkdir(directory, { recursive: true });
	const key = `${request.kind}-${request.irId}-${request.srId ?? "group"}`;
	const requestFile = path.join(directory, `${key}.request.json`);
	const receiptFile = path.join(directory, `${key}.receipt.json`);
	await fs.writeFile(
		requestFile,
		redact(
			JSON.stringify(
				{
					...request,
					instructions:
						"External authorized action only. Preserve original user branch/files/.omp. No reset, clean, stash, force push or platform approval claims. Perform a genuine exact-content merge in approved test scope, then record target commit. Registering a PR URL is not proof of platform approval. Never put credentials/capability URLs in this file.",
				},
				null,
				2,
			),
		),
		{ flag: "wx" },
	);
	const receipt = await pollWorkflow(
		async () => {
			try {
				return JSON.parse(await fs.readFile(receiptFile, "utf8")) as AIReqManualMergeReceipt;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		Boolean,
		`Explicit external manual ${request.kind} merge receipt (${receiptFile})`,
		timeout,
	);
	if (
		!receipt ||
		receipt.kind !== request.kind ||
		receipt.irId !== request.irId ||
		receipt.srId !== request.srId ||
		!/^[a-f0-9]{40,64}$/u.test(receipt.commit) ||
		receipt.targetBranch !== request.targetBranch ||
		receipt.platformVerified !== false ||
		!["controlled-test-scope", "externally-manually-merged"].includes(receipt.mode)
	)
		throw new Error("External manual merge receipt does not match the exact requested object and target");
	const url = new URL(receipt.prUrl);
	if (
		!/^https?:$/u.test(url.protocol) ||
		url.username ||
		url.password ||
		/token|key|secret|authorization/iu.test(url.search)
	)
		throw new Error("Manual PR URL must be an ordinary HTTP(S) URL with no credential material");
	return receipt;
}
async function verifyProductionResources(
	process: WorkflowConsumerProcess,
	payloadPath: string,
): Promise<BrowserReport["productionResources"]> {
	const payload = decodeAIReqWorkbenchAssets(JSON.parse(await fs.readFile(payloadPath, "utf8")));
	const resources: NonNullable<BrowserReport["productionResources"]> = [];
	for (const [name, asset] of payload.assets) {
		const response = await process.request(name === "/index.html" ? "" : name.slice(1));
		if (!response.ok) throw new Error(`Production AIReq resource ${name} returned ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (digest(bytes) !== digest(asset.bytes))
			throw new Error(`Public capability resource differs from generated production bytes: ${name}`);
		resources.push({ path: name, sha256: digest(bytes), size: bytes.length });
	}
	return resources;
}
async function preserveNativeEvidence(
	process: WorkflowConsumerProcess,
	directory: string,
	redact: (text: string) => string,
	excludedSessions: ReadonlySet<string>,
): Promise<void> {
	await fs.writeFile(path.join(directory, "native-stdout.log"), process.logs.stdout);
	await fs.writeFile(path.join(directory, "native-stderr.log"), process.logs.stderr);
	const view = await process.view().catch(() => undefined);
	if (view) await fs.writeFile(path.join(directory, "last-workflow-view.json"), redact(JSON.stringify(view, null, 2)));
	const views = view ? await Promise.all(view.projects.map(project => process.view(project.id))) : [];
	const references = views.flatMap(project => [
		...project.sessions,
		...[...project.groups, ...project.drafts].flatMap(group =>
			group.review?.reviewer && "sessionFile" in group.review.reviewer ? [group.review.reviewer] : [],
		),
	]);
	const sessions = new Set(references.filter(ref => !excludedSessions.has(ref.sessionId)).map(ref => ref.sessionFile));
	const collect = async (root: string): Promise<void> => {
		for (const entry of await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		})) {
			const file = path.join(root, entry.name);
			if (entry.isDirectory()) await collect(file);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) sessions.add(file);
		}
	};
	await collect(path.join(process.env.OMP_CONFIG_ROOT, "profiles/acceptance/agent"));
	await collect(process.env.HOME);
	const identities: Array<{ provider?: string; model?: string }> = [];
	if (views.length)
		await fs.writeFile(
			path.join(directory, "all-project-workflow-views.json"),
			redact(JSON.stringify(views, null, 2)),
		);
	for (const file of sessions) {
		const source = await fs.readFile(file, "utf8");
		await fs.writeFile(path.join(directory, `native-session-${digest(file).slice(0, 20)}.jsonl`), redact(source));
		for (const line of source.split(/\r?\n/u).filter(Boolean)) {
			const entry = JSON.parse(line) as SessionEntry;
			if (entry.type === "message" && entry.message.role === "assistant")
				identities.push({ provider: entry.message.provider, model: entry.message.model });
			else if (entry.type === "model_usage") identities.push({ provider: entry.provider, model: entry.model });
		}
	}
	await fs.writeFile(path.join(directory, "observed-inference-identities.json"), JSON.stringify(identities, null, 2));
	if (identities.some(identity => identity.provider !== "opencode-go" || identity.model !== "beam-free"))
		throw new Error(
			"Persisted native inference used a model other than the exact authorized opencode-go/beam-free; no substitution accepted",
		);
}

/** Presence checks are separate from runtime results; no credential values are returned. */
export async function aiReqAcceptancePrerequisites(options: AIReqE2EOptions): Promise<Record<string, unknown>> {
	const model = getBundledModels("opencode-go").find(item => item.id === "beam-free" && item.name === "Beam Free");
	if (!model || model.api !== "openai-completions" || model.baseUrl !== "https://opencode.ai/inference/go/v1")
		throw new PlatformPrerequisiteError(
			"beam-free-catalog",
			"Exact bundled OpenCode Go Beam Free transport required; model substitution/overrides are forbidden",
		);
	const result: Record<string, unknown> = {
		model: MODEL,
		roles: WORKFLOW_ROLES,
		realModel: true,
		textOnly: model.input.every(input => input === "text"),
		credentialInherited: Boolean(process.env.OPENCODE_API_KEY),
		gitMode:
			options.controlledGit === false
				? "external manually merged; operator receipts required"
				: "retained local bare control remote, actual-root linked worktrees; NOT platform PR approval",
		manualMergeReceipts: options.mergeReceipts ? path.resolve(options.mergeReceipts) : null,
		target: path.resolve(options.root),
		runtimeChecksPerformed: false,
	};
	if (options.browser !== "firefox") result.chrome = await installed(options.chrome, "Chrome");
	if (options.browser !== "chrome") {
		result.firefox = await installed(options.firefox, "Firefox128+");
		result.geckodriver = await installed(process.env.GECKODRIVER_EXECUTABLE, "geckodriver");
		result.python = await installed(process.env.PYTHON_EXECUTABLE, "Python with Selenium");
	}
	const payload = path.resolve(
		options.assetsPayload ?? path.join(repository, "packages/coding-agent/src/aireq-workbench/assets.generated.json"),
	);
	decodeAIReqWorkbenchAssets(JSON.parse(await fs.readFile(payload, "utf8")));
	result.productionPayload = payload;
	return result;
}

export async function runAIReqAIReqelopmentE2E(
	options: AIReqE2EOptions,
	authorization: AIReqE2EAuthorization = {},
): Promise<{ status: "passed" | "failed" | "blocked"; evidenceDir: string; browsers: BrowserReport[] }> {
	const credential = authorization.credential ?? process.env.OPENCODE_API_KEY;
	if (!credential)
		throw new PlatformPrerequisiteError(
			"opencode-authorization",
			"Inherit OPENCODE_API_KEY or pass an authorized credential in memory; no personal credential files are copied",
		);
	await aiReqAcceptancePrerequisites(options);
	const root = path.resolve(options.root);
	const before = await snapshotUserRoot(root);
	const runId = `aireq-real-${new Date().toISOString().replace(/[^0-9]/gu, "")}-${crypto.randomUUID()}`;
	const evidenceDir = path.join(path.resolve(options.evidenceDir ?? os.tmpdir()), runId);
	const relativeEvidence = path.relative(root, evidenceDir);
	if (!path.isAbsolute(relativeEvidence) && relativeEvidence !== ".." && !relativeEvidence.startsWith(`..${path.sep}`))
		throw new Error("Evidence/profile root must be outside the user repository");
	await fs.mkdir(evidenceDir, { recursive: true });
	const redact = workflowRedactor([credential]);
	await fs.writeFile(path.join(evidenceDir, "user-root-baseline.json"), JSON.stringify(before, null, 2));
	const gitEnvironment = isolatedWorkflowEnvironment(evidenceDir);
	const control =
		options.controlledGit === false
			? undefined
			: await prepareControlledGit(root, evidenceDir, runId, gitEnvironment, options.controlRemote);
	if (!control && !options.mergeReceipts)
		throw new Error("External manual mode requires an external merge receipt directory");
	const reports: BrowserReport[] = [];
	const browserNames: ("chrome" | "firefox")[] =
		options.browser === "both" ? ["chrome", "firefox"] : [options.browser];
	for (const name of browserNames) {
		const browserRoot = path.join(evidenceDir, name);
		const downloads = path.join(browserRoot, "downloads");
		const report: BrowserReport = { browser: name, status: "failed", steps: [] };
		reports.push(report);
		let native: WorkflowConsumerProcess | undefined;
		const initialSessions = new Set<string>();
		let nativeExited = false;
		let browserExited = false;
		let preservedUserRoot = false;
		try {
			await fs.mkdir(downloads, { recursive: true });
			await writeWorkflowProfile(browserRoot, MODEL);
			const env = isolatedWorkflowEnvironment(browserRoot);
			env.OPENCODE_API_KEY = credential;
			if (control)
				for (const key of [
					"GIT_CONFIG_COUNT",
					"GIT_CONFIG_KEY_0",
					"GIT_CONFIG_VALUE_0",
					"GIT_CONFIG_KEY_1",
					"GIT_CONFIG_VALUE_1",
				])
					env[key] = gitEnvironment[key];
			const secondary = path.join(browserRoot, "secondary-project");
			await fs.mkdir(secondary);
			await workflowGit(secondary, ["init", `--initial-branch=omp-aireq-acceptance/${runId}/${name}/secondary`], env);
			await fs.writeFile(path.join(secondary, "project-isolation.txt"), `Only secondary project ${runId}\n`);
			await workflowGit(secondary, ["add", "--", "project-isolation.txt"], env);
			await workflowGit(secondary, ["commit", "-m", "Isolated secondary project"], env);
			const businessProject = path.join(browserRoot, "business-source");
			await workflowGit(browserRoot, ["clone", "--no-checkout", "--no-hardlinks", root, businessProject], env);
			const remote = await workflowGit(root, ["remote", "get-url", "origin"], env);
			if (/^[a-z]+:\/\//iu.test(remote)) {
				const remoteUrl = new URL(remote);
				if (remoteUrl.username || remoteUrl.password || remoteUrl.search)
					throw new Error("Acceptance will not copy credential-bearing Git remote URLs");
			}
			await workflowGit(businessProject, ["remote", "set-url", "origin", remote], env);
			const advertised = await workflowGit(root, ["ls-remote", "--symref", "origin", "HEAD"], env);
			const defaultBranch = /^ref: refs\/heads\/([^\t\n]+)\tHEAD/mu.exec(advertised)?.[1];
			if (!defaultBranch) throw new Error("Actual origin default branch could not be determined");
			const defaultCommit = /^([a-f0-9]{40,64})\tHEAD$/mu.exec(advertised)?.[1];
			if (!defaultCommit) throw new Error("Actual default commit was not advertised");
			await workflowGit(
				businessProject,
				["fetch", "--no-tags", "origin", `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`],
				env,
			);
			await workflowGit(
				businessProject,
				["switch", "--create", `omp-aireq-acceptance/${runId}/${name}/business`, defaultCommit],
				env,
			);
			native = new WorkflowConsumerProcess(root, env, redact);
			await native.ready();
			const registry = await native.view();
			const target = registry.projects.find(project => path.resolve(project.root) === root);
			if (!target)
				throw new PlatformPrerequisiteError(
					"actual-project-root",
					"AIReq did not register the actual requested test repository",
				);
			const initial = await native.view(target.id);
			for (const ref of initial.sessions) initialSessions.add(ref.sessionId);
			for (const group of [...initial.groups, ...initial.drafts])
				if (group.review) initialSessions.add(group.review.reviewer.sessionId);
			if (initial.activeSrId)
				throw new PlatformPrerequisiteError(
					"existing-active-sr",
					"The actual project already has a developing SR; explicit continuation/end is required, never automatic takeover",
				);
			report.productionResources = await verifyProductionResources(
				native,
				path.resolve(
					options.assetsPayload ??
						path.join(repository, "packages/coding-agent/src/aireq-workbench/assets.generated.json"),
				),
			);
			const consumer = native;
			const run = async (browser: DevelopmentBrowser) => {
				report.identity = browser.identity;
				if (name === "firefox" && browser.identity.major !== 128)
					throw new PlatformPrerequisiteError(
						"firefox128",
						"This acceptance requires actual Firefox 128 ESR, not a newer browser substituted for compatibility evidence",
					);
				const view = async (projectId?: string, irId?: string, srId?: string): Promise<AIReqWorkflowView> => {
					const query = new URLSearchParams();
					if (projectId) query.set("projectId", projectId);
					if (irId) query.set("irId", irId);
					if (srId) query.set("srId", srId);
					const response = await consumer.request(`workflow?${query}`);
					if (!response.ok)
						throw new Error(`Public observation failed: ${response.status} ${await response.text()}`);
					return response.json();
				};
				const material = async (projectId: string, irId: string, file: string, srId?: string) => {
					const query = new URLSearchParams({ projectId, irId, path: file });
					if (srId) query.set("srId", srId);
					const response = await consumer.request(`workflow/material?${query}`);
					if (!response.ok)
						throw new Error(`Actual material read failed: ${response.status} ${await response.text()}`);
					return response.json() as Promise<{ content?: string; error?: string }>;
				};
				await runAIReqJourney({
					browser,
					url: consumer.url,
					root,
					businessProject,
					secondaryProject: secondary,
					evidenceDir: browserRoot,
					downloadDirectory: downloads,
					timeoutMs: options.timeoutMs ?? 900_000,
					business: name === "firefox" ? DEV_VERSION_BUSINESS : DEV_REAL_BUSINESS,
					redact,
					view,
					material,
					codePrUrl: request =>
						control
							? Promise.resolve(
									`https://controlled-test.invalid/${request.kind}/${request.irId}/${request.srId ?? "group"}`,
								)
							: manualCodePrUrl(
									path.resolve(options.mergeReceipts!),
									request,
									options.manualTimeoutMs ?? 3_600_000,
									redact,
								),
					completedBack: async request => {
						await consumer.bind(request.projectId, request.irId, request.srId);
						const { response, result } = await consumer.command({
							type: "backStage",
							stage: "executing",
							...request,
							operationId: `completed-back-refusal-${crypto.randomUUID()}`,
						});
						return { httpStatus: response.status, status: result.status, error: result.error };
					},
					manualMerge: request =>
						control
							? controlledManualMerge(control, request, env, browserRoot)
							: manualReceipt(
									path.resolve(options.mergeReceipts!),
									request,
									options.manualTimeoutMs ?? 3_600_000,
									redact,
								),
					record: async item => {
						report.steps.push(item);
						await fs.appendFile(path.join(browserRoot, "steps.jsonl"), `${redact(JSON.stringify(item))}\n`);
					},
				});
				if (
					report.steps.length !== DEV_JOURNEY_STEPS.length ||
					DEV_JOURNEY_STEPS.some(
						id => report.steps.filter(step => step.id === id && step.status === "passed").length !== 1,
					)
				)
					throw new Error(
						`Real acceptance did not pass every one of the ${DEV_JOURNEY_STEPS.length} distinct journey steps`,
					);
				const rendered = await browser.page.evaluate<string>("document.body.innerText");
				if (redact(rendered) === rendered) await browser.page.screenshot(path.join(browserRoot, "completed.png"));
			};
			if (name === "chrome")
				await withAIReqChrome(options.chrome!, browserRoot, downloads, run, options.headless ?? true);
			else {
				const browserEnv = isolatedWorkflowEnvironment(browserRoot);
				browserEnv.GECKODRIVER_EXECUTABLE = process.env.GECKODRIVER_EXECUTABLE!;
				browserEnv.PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE!;
				await withFirefoxBrowser(
					{
						firefox: options.firefox,
						downloadDirectory: downloads,
						environment: browserEnv,
						headless: options.headless ?? true,
						viewport: { width: 1440, height: 1000 },
					},
					run,
				);
			}
			browserExited = true;
			await preserveNativeEvidence(native, browserRoot, redact, initialSessions);
			report.status = "passed";
		} catch (error) {
			report.status = error instanceof PlatformPrerequisiteError ? "blocked" : "failed";
			report.error = redact(String(error));
		} finally {
			if (native) {
				try {
					await preserveNativeEvidence(native, browserRoot, redact, initialSessions);
				} catch (error) {
					report.error = `${report.error ?? ""}\nNative evidence capture: ${redact(String(error))}`;
					report.status = "failed";
				}
				try {
					await native.stop();
					nativeExited = true;
				} catch (error) {
					report.error = `${report.error ?? ""}\nNative settlement: ${redact(String(error))}`;
					report.status = "failed";
				}
				try {
					await preserveNativeEvidence(native, browserRoot, redact, initialSessions);
				} catch (error) {
					report.error = `${report.error ?? ""}\nFinal native transcript capture: ${redact(String(error))}`;
					report.status = "failed";
				}
				await fs.writeFile(path.join(browserRoot, "native-stdout.log"), native.logs.stdout);
				await fs.writeFile(path.join(browserRoot, "native-stderr.log"), native.logs.stderr);
			}
			if (!native) nativeExited = true;
			try {
				await assertUserRootPreserved(root, before);
				preservedUserRoot = true;
			} catch (error) {
				report.error = `${report.error ?? ""}\nUser-root preservation: ${redact(String(error))}`;
				report.status = "failed";
			}
			report.cleanup = { nativeExited, browserExited, preservedUserRoot };
			for (const id of DEV_JOURNEY_STEPS)
				if (!report.steps.some(step => step.id === id))
					report.steps.push({
						id,
						status: "blocked",
						startedAt: new Date().toISOString(),
						completedAt: new Date().toISOString(),
						error: "Not exercised because an earlier prerequisite or actual journey step failed; not a pass/skip",
					});
		}
		if (report.status !== "passed" || !nativeExited || !preservedUserRoot) break;
	}
	if (control && reports.every(report => report.cleanup?.nativeExited)) {
		try {
			await restoreControlledTracking(root, control, gitEnvironment);
		} catch (error) {
			const report = reports.at(-1);
			if (report) {
				report.status = "failed";
				report.error = `${report.error ?? ""}\nTracking preservation: ${redact(String(error))}`;
			}
		}
	}
	for (const browser of browserNames)
		if (!reports.some(report => report.browser === browser))
			reports.push({
				browser,
				status: "blocked",
				error: "Not launched after an earlier browser failure; no model substitution, implicit slot takeover or fabricated browser pass",
				steps: DEV_JOURNEY_STEPS.map(id => ({
					id,
					status: "blocked",
					startedAt: new Date().toISOString(),
					completedAt: new Date().toISOString(),
					error: "Not exercised",
				})),
			});
	for (const report of reports) {
		await fs.mkdir(path.join(evidenceDir, report.browser), { recursive: true });
		await fs.writeFile(
			path.join(evidenceDir, report.browser, "report.json"),
			redact(JSON.stringify(report, null, 2)),
		);
	}
	const status =
		reports.every(item => item.status === "passed") && reports.length === (options.browser === "both" ? 2 : 1)
			? "passed"
			: reports.some(item => item.status === "failed")
				? "failed"
				: "blocked";
	const result = {
		status,
		evidenceDir,
		browsers: reports,
		controlRemote: control?.remote,
		gitMode: control ? "controlled local Git; platform approval unverified" : "external manual orchestration",
	} as const;
	await fs.writeFile(
		path.join(evidenceDir, "report.json"),
		redact(
			JSON.stringify(
				{
					...result,
					model: MODEL,
					roles: WORKFLOW_ROLES,
					catalogTransportUnmodified: true,
					credentialStorage: "inherited/in-memory child environment only",
					platformApproval: "not claimed; manual registration and Git exact-content verification are separate",
					nfs: "local directory simulation only; actual NFS/multi-host not claimed",
					notClaimed: [
						"Actual NFS/sequential multi-host handoff",
						"Company PR creation/review/platform approval",
						"Physical mobile/desktop IME or release-channel qualification",
						"Host-process restart while an SR waits for PR (browser reload only)",
						"All scenarios from linked step names alone; unmapped and negative cases require their own exercised evidence",
					],
					userRootPreserved: reports.every(item => item.cleanup?.preservedUserRoot),
					realModelAttempts:
						"All attempts/failures retained in native transcripts; no retry substitution or fixture output",
				},
				null,
				2,
			),
		),
	);
	await writeScenarioEvidence(evidenceDir, reports);
	return result;
}

const SCENARIO_STEPS: Record<string, string[]> = {
	"小需求只拆一个 SR": ["real-requirements"],
	版本与开发分支分离: ["local-intake"],
	浏览器访问长期宿主: ["browser-intake"],
	"业务草稿不操作 Git": ["browser-intake"],
	开发人员保留本地新建: ["local-intake"],
	"SR 不能只有标题": ["real-requirements"],
	"review 后修改需要重新确认": ["fixed-snapshot-review", "review-invalidation"],
	包必须完整且可验证: ["zip-handoff"],
	修改后收回可下载资格: ["review-invalidation"],
	包不复制运行环境: ["zip-handoff"],
	"从另一 clone 导入": ["zip-import"],
	无需原会话交接: ["zip-import"],
	内部确认不启动开发: ["fixed-snapshot-review"],
	需求合入事实核对: ["requirements-exact-merge"],
	查看过去阶段: ["history-not-transition"],
	只查看历史不失效: ["history-not-transition"],
	刷新恢复查看位置而非执行授权: ["history-not-transition"],
	工作台图标随生产资源交付: ["browser-favicon-resource"],
	统一材料入口: ["material-menu-readonly-download", "material-discuss-unsent-native-draft", "delivery-pr"],
	材料未生成或失效: ["invalidated-material-history"],
	修改正式内容: ["material-menu-readonly-download", "material-discuss-unsent-native-draft"],
	实际开始: ["sr-solution"],
	等待交付仍占用: ["code-pr-registration"],
	代码合入后结束: ["code-exact-merge"],
	结束不等于清理: ["code-exact-merge", "completed-back-refusal"],
	已交付后请求返回: ["completed-back-refusal"],
	普通修复和技术返工: ["pr-repair-back", "pr-repair-real-ut-st", "pr-repair-reapproval", "code-pr-resubmission"],
	方案计划推进: ["solution-approval", "planning-approval"],
	开发验证报告: ["execution-real-ut-st"],
	实际修改方案计划: ["code-preserving-back"],
	技术材料职责: ["sr-solution", "planning-approval", "execution-real-ut-st", "delivery-pr"],
	完成报告产生: ["execution-real-ut-st"],
	多项目单入口与选择隔离: ["project-isolation"],
	左下角项目切换: ["project-isolation"],
	浏览器整理与开发交接: ["browser-intake", "zip-handoff", "zip-import"],
};
// These are exercised slices, not a claim that every clause of the source scenario was observed.
const SCENARIO_PARTIAL_COVERAGE: Record<string, { observed: string; unobserved: string }> = {
	刷新恢复查看位置而非执行授权: {
		observed:
			"Valid historical solution viewing is restored by reload during actual executing; exact native session/phase/round/draft, workflow authority and journal are unchanged.",
		unobserved:
			"Deleted/stale objects, invalid stages, denied storage, separate entrances and unsaved-empty entry behavior.",
	},
	查看过去阶段: {
		observed:
			"Solution history is viewed while the actual phase remains executing; public native-surface identity/draft and native journal remain unchanged across viewing/reload.",
		unobserved:
			"An already in-flight model/tool request continuing during the history click; this step uses settled actual executing outputs.",
	},
	统一材料入口: {
		observed:
			"Real IR/SR/solution/plan/completion/UT/ST/delivery selection, exact readonly host content, retained collapse selection, exact UTF8 download, and current unsent native Markdown discussion with independent-project draft isolation.",
		unobserved:
			"Journey Copy records the actual click/errors only. Safe clipboard read/restore is unavailable in DevelopmentPage; Firefox 128 exact copied bytes remain unobserved. The parent Chrome fixture covers the copied-text contract separately.",
	},
	材料未生成或失效: {
		observed:
			"Actual Back-invalidated UT/ST reports retain exact historical host bytes and explicit invalid/history status without changing current authority.",
		unobserved:
			"Missing/uncreated material and transport/host-file error rendering; no artificial failure state is introduced.",
	},
	修改正式内容: {
		observed:
			"Formal material has no editable body in its pane; Discuss inserts exact real content only into the current unsent native Markdown draft, without input/model or authority transition, then clears only that owned draft.",
		unobserved:
			"AI title/body revision through every authorized phase, rename-form and drag-split negatives outside the material pane.",
	},
};
async function writeScenarioEvidence(directory: string, reports: BrowserReport[]): Promise<void> {
	const rows: object[] = [];
	for (const change of await fs.readdir(path.join(repository, "openspec/changes"))) {
		if (!change.startsWith("refactor-aireq-")) continue;
		const specs = path.join(repository, "openspec/changes", change, "specs");
		for (const capability of await fs.readdir(specs)) {
			const source = path.join(specs, capability, "spec.md");
			let operation = "";
			let requirement = "";
			for (const line of (await fs.readFile(source, "utf8")).split(/\r?\n/u)) {
				const section = /^## (ADDED|MODIFIED|REMOVED) Requirements/u.exec(line);
				if (section) operation = section[1];
				const title = /^### Requirement:\s*(.+)/u.exec(line);
				if (title) requirement = title[1];
				const scenario = /^#### Scenario:\s*(.+)/u.exec(line);
				if (!scenario) continue;
				const steps = SCENARIO_STEPS[scenario[1]] ?? [];
				rows.push({
					change,
					capability,
					operation,
					requirement,
					scenario: scenario[1],
					source: path.relative(repository, source).replaceAll("\\", "/"),
					browserEvidence: reports.map(report => ({
						browser: report.browser,
						status:
							steps.length &&
							steps.every(id => report.steps.some(step => step.id === id && step.status === "passed"))
								? SCENARIO_PARTIAL_COVERAGE[scenario[1]]
									? "observed-partial"
									: "observed"
								: "not-exercised-or-blocked",
						stepIds: steps,
						coverage: SCENARIO_PARTIAL_COVERAGE[scenario[1]],
					})),
					boundary:
						"Only actual facts from linked successful steps are observations, not blanket proof of every clause in a scenario. Unmapped negative/removal/NFS/TUI/mobile/company-platform scenarios require separately exercised evidence; no mock or source-existence pass inferred.",
				});
			}
		}
	}
	await fs.writeFile(path.join(directory, "scenario-evidence.json"), JSON.stringify(rows, null, 2));
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const option = (key: string) => {
		const index = args.indexOf(key);
		return index < 0 ? undefined : args[index + 1];
	};
	const allowed = new Set([
		"--browser",
		"--root",
		"--chrome",
		"--firefox",
		"--evidence",
		"--assets-payload",
		"--merge-receipts",
		"--control-remote",
		"--timeout-ms",
		"--manual-timeout-ms",
		"--headed",
		"--check",
		"--external-manual",
	]);
	for (let index = 0; index < args.length; index++) {
		if (!allowed.has(args[index]))
			throw new Error(
				`Unknown CLI option at argument ${index + 1}; credentials are accepted only through inherited environment/in-memory API`,
			);
		if (!["--headed", "--check", "--external-manual"].includes(args[index])) {
			if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${args[index]}`);
			index++;
		}
	}
	const browser = option("--browser") ?? "both";
	if (!["chrome", "firefox", "both"].includes(browser)) throw new Error("--browser must be chrome, firefox or both");
	const mergeReceipts = option("--merge-receipts");
	if (args.includes("--external-manual") && !mergeReceipts)
		throw new Error("--external-manual requires --merge-receipts; platform/merge facts cannot be fabricated");
	const options: AIReqE2EOptions = {
		browser: browser as AIReqE2EOptions["browser"],
		root: option("--root") ?? "F:/testgithub/test",
		chrome: option("--chrome"),
		firefox: option("--firefox"),
		headless: !args.includes("--headed"),
		evidenceDir: option("--evidence"),
		assetsPayload: option("--assets-payload"),
		mergeReceipts,
		controlledGit: !args.includes("--external-manual"),
		controlRemote: option("--control-remote"),
		timeoutMs: Number(option("--timeout-ms") ?? 900_000),
		manualTimeoutMs: Number(option("--manual-timeout-ms") ?? 3_600_000),
	};
	for (const value of [options.timeoutMs, options.manualTimeoutMs])
		if (!value || !Number.isSafeInteger(value) || value < 1)
			throw new Error("Timeouts must be positive integer milliseconds");
	try {
		if (args.includes("--check")) console.log(JSON.stringify(await aiReqAcceptancePrerequisites(options), null, 2));
		else {
			const result = await runAIReqAIReqelopmentE2E(options);
			console.log(JSON.stringify({ status: result.status, evidenceDir: result.evidenceDir }));
			if (result.status !== "passed") process.exitCode = 1;
		}
	} catch (error) {
		console.error(workflowRedactor([process.env.OPENCODE_API_KEY ?? ""])(String(error)));
		process.exitCode = 1;
	}
}
