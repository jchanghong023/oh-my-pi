import { afterEach, describe, expect, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { currentBuildHost } from "../../src/cli/build-service";
import { runUpdateCommand } from "../../src/cli/update-cli";
import { isolatedUpdateTests } from "../helpers/update-repository-test";

const { it } = isolatedUpdateTests(import.meta.path);
const host = await currentBuildHost();
const binaryName = process.platform === "win32" ? "omp-windows-x64.exe" : "omp-linux-x64";
const unsupported = process.arch !== "x64" || (process.platform !== "win32" && host.asset !== "linux-x64");
const posixOnly = unsupported || process.platform === "win32";
const releaseBase = "https://cnb.cool/jchanghong/bin/-/releases";
const rollingMetadata = `${releaseBase}/tags/omp`;
const token = "fixture-cnb-token";
const version = "18.0.9+fork.137";
const previousVersion = "18.0.9+fork.136";
const check = { force: false, check: true };
const install = { force: false, check: false };

function executable(reported: string): string {
	return `#!/bin/sh\nprintf '%s\\n' 'omp/${reported}'\n`;
}

function release(binary: string, tag = "omp", reported = version): Response {
	return Response.json({
		tag_name: tag,
		name: `v${reported}`,
		assets: [
			{
				name: binaryName,
				size: Buffer.byteLength(binary),
				hash_algo: "sha256",
				hash_value: Bun.SHA256.hash(binary, "hex"),
			},
		],
	});
}

interface RecordedRequest {
	url: string;
	init?: RequestInit | BunFetchRequestInit;
}

function recordFetch(
	respond: (url: string) => Response = url => {
		throw new Error(`Unexpected updater request: ${url}`);
	},
) {
	const requests: RecordedRequest[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
				const url = String(input);
				requests.push({ url, init });
				return respond(url);
			},
			{ preconnect: globalThis.fetch.preconnect },
		),
	);
	return requests;
}

function expectReleaseRequest(request: RecordedRequest, url: string, authenticated = false): void {
	expect(request.url).toBe(url);
	const headers = new Headers(request.init?.headers);
	expect(headers.get("accept")).toBe("application/vnd.cnb.api+json");
	expect(headers.get("authorization")).toBe(authenticated ? `Bearer ${token}` : null);
	expect(request.init).toMatchObject({
		redirect: "manual",
		signal: expect.any(AbortSignal),
		tls: { rejectUnauthorized: true },
	});
}

async function withStandalone(run: (dir: string, target: string) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-cnb-update-")));
	const previousExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
	try {
		const bin = path.join(root, "bin");
		await fs.mkdir(bin);
		const target = path.join(bin, process.platform === "win32" ? "omp.exe" : "omp");
		if (process.platform === "win32") await writeNativeVersionFixture(target, previousVersion);
		else await fs.writeFile(target, executable(previousVersion), { mode: 0o755 });
		process.env.PATH = root;
		process.env.HOME = root;
		process.env.USERPROFILE = root;
		process.env.PI_COMPILED = "1";
		Object.defineProperty(process, "execPath", { ...previousExecPath, value: target });
		await run(root, target);
	} finally {
		if (previousExecPath) Object.defineProperty(process, "execPath", previousExecPath);
		await removeWithRetries(root);
	}
}

async function writeNativeVersionFixture(ompPath: string, version: string): Promise<void> {
	const entrypoint = path.join(path.dirname(ompPath), "fixture.ts");
	await Bun.write(entrypoint, `console.log(${JSON.stringify(`omp/${version}`)});`);
	const result = await Bun.build({ entrypoints: [entrypoint], target: "bun", compile: { outfile: ompPath } });
	if (!result.success) throw new AggregateError(result.logs, "Native OMP fixture compilation failed");
}

describe("runUpdateCommand CNB releases", () => {
	afterEach(() => vi.restoreAllMocks());

	it("refuses checks and installs offline even with a CNB token configured", async () => {
		process.env.CNB_TOKEN = token;
		process.env.OMP_OFFLINE = " yes ";
		const requests = recordFetch();

		await expect(runUpdateCommand(check)).rejects.toThrow(/offline mode/i);
		await expect(runUpdateCommand({ ...install, force: true })).rejects.toThrow(/offline mode/i);
		expect(requests).toEqual([]);
	});

	it.skipIf(unsupported)("checks the public release without CNB_TOKEN", async () => {
		await withStandalone(async () => {
			process.env.GITHUB_TOKEN = "fixture-unrelated-token";
			const requests = recordFetch(() => release(executable(version)));

			expect(await runUpdateCommand(check)).toEqual({ kind: "available", version });
			expect(requests).toHaveLength(1);
			expectReleaseRequest(requests[0]!, rollingMetadata);
		});
	});

	it.skipIf(unsupported)("reports default metadata HTTP 401 without using the configured token", async () => {
		await withStandalone(async () => {
			process.env.CNB_TOKEN = token;
			const requests = recordFetch(() => new Response(null, { status: 401 }));

			await expect(runUpdateCommand(check)).rejects.toThrow(/metadata.*HTTP 401/);
			expect(requests).toHaveLength(1);
			expectReleaseRequest(requests[0]!, rollingMetadata);
		});
	});

	it.skipIf(posixOnly)("checks the configured tag and treats a PATH symlink as the running binary", async () => {
		await withStandalone(async (root, target) => {
			process.env.CNB_TOKEN = token;
			process.env.PI_UPDATE_REPOSITORY = `mirror/bin@v${version}`;
			await fs.symlink(target, path.join(root, "omp"));
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const requests = recordFetch(() => release(executable(version), `v${version}`));

			expect(await runUpdateCommand(check)).toEqual({ kind: "available", version });
			expect(await Bun.file(target).text()).toBe(executable(previousVersion));
			expect(requests).toHaveLength(1);
			expectReleaseRequest(requests[0]!, `https://cnb.cool/mirror/bin/-/releases/tags/v18.0.9%2Bfork.137`);
			expect(log.mock.calls.some(([message]) => String(message).includes("Warning"))).toBe(false);
		});
	});

	it.skipIf(posixOnly)("does not download the same version or force a downgrade", async () => {
		await withStandalone(async (_root, target) => {
			process.env.CNB_TOKEN = token;
			let offered = previousVersion;
			const requests = recordFetch(() => release(executable(offered), "omp", offered));

			expect(await runUpdateCommand(install)).toEqual({ kind: "current" });
			offered = "18.0.9+fork.135";
			expect(await runUpdateCommand({ ...install, force: true })).toEqual({ kind: "current" });
			expect(requests.map(request => request.url)).toEqual([rollingMetadata, rollingMetadata]);
			expect(await Bun.file(target).text()).toBe(executable(previousVersion));
		});
	});

	it.skipIf(posixOnly)("leaves a managed install untouched without requesting a release", async () => {
		await withStandalone(async (root, target) => {
			process.env.CNB_TOKEN = token;
			process.env.MISE_INSTALLS_DIR = root;
			const requests = recordFetch();

			expect(await runUpdateCommand(install)).toMatchObject({
				kind: "unsupported",
				reason: expect.stringMatching(/mise/),
			});
			expect(requests).toEqual([]);
			expect(await Bun.file(target).text()).toBe(executable(previousVersion));
		});
	});

	it.skipIf(posixOnly)("updates from the public CNB release without a token", async () => {
		await withStandalone(async (root, target) => {
			const candidate = executable(version);
			const pathLauncher = path.join(root, "omp");
			await fs.writeFile(pathLauncher, executable("999.0.0"), { mode: 0o755 });
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const download = `${releaseBase}/download/omp/${binaryName}`;
			const signed = "https://objects.cnb.cool/cnb-fixture?signature=fixture";
			const requests = recordFetch(url => {
				if (url === rollingMetadata) return release(candidate);
				if (url === download) return new Response(null, { status: 302, headers: { location: signed } });
				if (url === signed) return new Response(candidate);
				throw new Error(`Unexpected updater request: ${url}`);
			});

			expect(await runUpdateCommand(install)).toEqual({ kind: "installed", version });
			expect(await Bun.file(target).text()).toBe(candidate);
			expect(await Bun.file(pathLauncher).text()).toBe(executable("999.0.0"));
			expect(requests).toHaveLength(3);
			expectReleaseRequest(requests[0]!, rollingMetadata);
			expectReleaseRequest(requests[1]!, download);
			expect(requests[2]!.url).toBe(signed);
			expect(new Headers(requests[2]!.init?.headers).has("authorization")).toBe(false);
			expect(requests[2]!.init?.redirect).toBe("error");
			expect(log.mock.calls.some(([message]) => String(message).includes(`Updated to ${version}`))).toBe(true);
			expect(log.mock.calls.some(([message]) => String(message).includes("Warning"))).toBe(true);
		});
	});

	it.skipIf(posixOnly)("uses the private API after public metadata is hidden without forwarding its Bearer", async () => {
		await withStandalone(async (_root, target) => {
			process.env.CNB_TOKEN = ` ${token} `;
			process.env.PI_UPDATE_REPOSITORY = "mirror/bin";
			const candidate = executable(version);
			const publicMetadata = "https://cnb.cool/mirror/bin/-/releases/tags/omp";
			const privateBase = "https://api.cnb.cool/mirror/bin/-/releases";
			const privateMetadata = `${privateBase}/tags/omp`;
			const privateDownload = `${privateBase}/download/omp/${binaryName}`;
			const signed = "https://objects.cnb.cool/cnb-fixture?signature=fixture";
			const requests = recordFetch(url => {
				if (url === publicMetadata) return new Response(null, { status: 404 });
				if (url === privateMetadata) return release(candidate);
				if (url === privateDownload) return new Response(null, { status: 302, headers: { location: signed } });
				if (url === signed) return new Response(candidate);
				throw new Error(`Unexpected updater request: ${url}`);
			});

			expect(await runUpdateCommand(install)).toEqual({ kind: "installed", version });
			expect(await Bun.file(target).text()).toBe(candidate);
			expect(requests).toHaveLength(4);
			expectReleaseRequest(requests[0]!, publicMetadata);
			expectReleaseRequest(requests[1]!, privateMetadata, true);
			expectReleaseRequest(requests[2]!, privateDownload, true);
			expect(requests[3]!.url).toBe(signed);
			expect(new Headers(requests[3]!.init?.headers).has("authorization")).toBe(false);
			expect(requests[3]!.init?.redirect).toBe("error");
		});
	});

	it.skipIf(posixOnly)("does not fall back on server errors or invalid public metadata", async () => {
		await withStandalone(async () => {
			process.env.CNB_TOKEN = token;
			process.env.PI_UPDATE_REPOSITORY = "mirror/bin";
			const publicMetadata = "https://cnb.cool/mirror/bin/-/releases/tags/omp";
			let response = new Response(null, { status: 500 });
			const requests = recordFetch(() => response);

			await expect(runUpdateCommand(check)).rejects.toThrow(/metadata.*HTTP 500/);
			response = new Response("not JSON");
			await expect(runUpdateCommand(check)).rejects.toThrow(/Failed to check for updates/);
			expect(requests).toHaveLength(2);
			expectReleaseRequest(requests[0]!, publicMetadata);
			expectReleaseRequest(requests[1]!, publicMetadata);
		});
	});

	it.skipIf(posixOnly)("does not fall back when a public release's download returns HTTP 403", async () => {
		await withStandalone(async (_root, target) => {
			process.env.CNB_TOKEN = token;
			process.env.PI_UPDATE_REPOSITORY = "mirror/bin";
			const publicBase = "https://cnb.cool/mirror/bin/-/releases";
			const metadata = `${publicBase}/tags/omp`;
			const download = `${publicBase}/download/omp/${binaryName}`;
			const requests = recordFetch(url => {
				if (url === metadata) return release(executable(version));
				if (url === download) return new Response(null, { status: 403 });
				throw new Error(`Unexpected updater request: ${url}`);
			});

			await expect(runUpdateCommand(install)).rejects.toThrow(/download redirect.*HTTP 403/);
			expect(requests).toHaveLength(2);
			expectReleaseRequest(requests[0]!, metadata);
			expectReleaseRequest(requests[1]!, download);
			expect(await Bun.file(target).text()).toBe(executable(previousVersion));
		});
	});
});
