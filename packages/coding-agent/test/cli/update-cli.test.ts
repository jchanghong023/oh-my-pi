import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fixedNpmRegistry } from "../../src/cli/npm-registry";
import {
	compareUpdateVersions,
	getLatestGitHubRelease,
	getLatestRelease,
	runUpdateCommand,
} from "../../src/cli/update-cli";

const npmjs = fixedNpmRegistry();

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("compareUpdateVersions", () => {
	it("orders fork builds whose SemVer precedence ignores build metadata", () => {
		expect(compareUpdateVersions("18.0.6+fork.124", "18.0.6+fork.123")).toBeGreaterThan(0);
		expect(compareUpdateVersions("18.0.6+fork.122", "18.0.6+fork.123")).toBeLessThan(0);
		expect(compareUpdateVersions("18.0.7+fork.1", "18.0.6+fork.999")).toBeGreaterThan(0);
	});

	it("offers a same-baseline fork release to a local binary without a build counter", () => {
		expect(compareUpdateVersions("18.6.2+fork.123", "18.6.2")).toBeGreaterThan(0);
		expect(compareUpdateVersions("18.6.2", "18.6.2+fork.123")).toBeLessThan(0);
		expect(compareUpdateVersions("18.6.2+other.123", "18.6.2")).toBe(0);
	});
});

describe("getLatestGitHubRelease", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("maps the fork's latest GitHub release to a binary-only update", async () => {
		let requestedUrl = "";
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				requestedUrl = String(input);
				return Response.json({ tag_name: "v18.0.6+fork.123" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const release = await getLatestGitHubRelease("jchanghong023/oh-my-pi");

		expect(requestedUrl).toBe("https://api.github.com/repos/jchanghong023/oh-my-pi/releases/latest");
		expect(release).toEqual({
			tag: "v18.0.6+fork.123",
			version: "18.0.6+fork.123",
			dist: "binary",
			packages: {
				pkg: "@oh-my-pi/pi-coding-agent",
				natives: "@oh-my-pi/pi-natives",
			},
			registry: "",
		});
	});

	it("uses gh login credentials when checking the latest release without environment tokens", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-update-gh-"));
		const previous = { PATH: Bun.env.PATH, GITHUB_TOKEN: Bun.env.GITHUB_TOKEN, GH_TOKEN: Bun.env.GH_TOKEN };
		try {
			const ghPath = path.join(directory, process.platform === "win32" ? "gh.cmd" : "gh");
			await fs.writeFile(
				ghPath,
				process.platform === "win32"
					? "@echo off\r\necho fixture-gh-token\r\n"
					: "#!/bin/sh\nprintf '%s\\n' fixture-gh-token\n",
				{ mode: 0o755 },
			);
			// Never fall through to the developer's real gh login if the fixture
			// cannot launch on this platform.
			Bun.env.PATH = directory;
			Bun.env.GITHUB_TOKEN = "";
			Bun.env.GH_TOKEN = "";
			let authorization: string | null = null;
			vi.spyOn(globalThis, "fetch").mockImplementation(
				Object.assign(
					async (_input: FetchInput, init?: FetchInit) => {
						authorization = new Headers(init?.headers).get("Authorization");
						return Response.json({ tag_name: "v18.6.2+fork.125" });
					},
					{ preconnect: globalThis.fetch.preconnect },
				),
			);
			await getLatestGitHubRelease("jchanghong023/oh-my-pi");
			expect<string | null>(authorization).toBe("Bearer fixture-gh-token");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete Bun.env[key];
				else Bun.env[key] = value;
			}
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				const decoded = decodeURIComponent(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (decoded.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows omp.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", omp: { dist: "npm" } },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs });

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest",
			"https://registry.npmjs.org/@new%2fomp/latest",
		]);
	});
	it("fetches the canary dist-tag when checking the canary channel", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": { version: "999.0.0-canary.1" },
		});

		await getLatestRelease({ channel: "canary", registries: npmjs });

		expect(urls).toEqual(["https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/canary"]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease({ registries: npmjs });

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" });
	});
});

describe("getLatestRelease configured registry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const feed = () => ({
		url: "https://npm.corp.example/api/npm/feed/",
		source: "/home/u/.npmrc",
		authorization: "Bearer s3cret",
	});

	it("queries the configured feed with its credentials and reports it for the install pin", async () => {
		const requests: { url: string; authorization: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput, init?: FetchInit) => {
					requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
					return Response.json({ version: "999.0.0" });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(requests).toEqual([
			{
				url: "https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest",
				authorization: "Bearer s3cret",
			},
		]);
		expect(release.registry).toBe("https://npm.corp.example/api/npm/feed/");
	});

	it("falls back to the full packument when the feed does not serve the dist-tag shortcut", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return new Response(null, { status: 404, statusText: "Not Found" });
					return Response.json({
						"dist-tags": { latest: "999.2.0" },
						versions: { "999.2.0": { version: "999.2.0", omp: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toEqual([
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest",
			"https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent",
		]);
		expect(release.version).toBe("999.2.0");
		expect(release.dist).toBe("binary");
	});

	it("resolves the tagged version when the feed answers the dist-tag shortcut with the full packument", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					urls.push(String(input));
					return Response.json({
						"dist-tags": { latest: "999.3.0" },
						versions: { "999.3.0": { version: "999.3.0", omp: { dist: "binary" } } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toEqual(["https://npm.corp.example/api/npm/feed/@oh-my-pi%2fpi-coding-agent/latest"]);
		expect(release.version).toBe("999.3.0");
		expect(release.dist).toBe("binary");
	});

	it("falls back to the full packument when the shortcut returns 200 without a version", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return Response.json({ success: false, error: "not found" });
					return Response.json({
						"dist-tags": { latest: "999.4.0" },
						versions: { "999.4.0": { version: "999.4.0" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.4.0");
	});

	it("falls back to the full packument when the shortcut returns 200 with a non-JSON body", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					const url = String(input);
					urls.push(url);
					if (url.endsWith("/latest")) return new Response("<html>Nexus</html>", { status: 200 });
					return Response.json({
						"dist-tags": { latest: "999.5.0" },
						versions: { "999.5.0": { version: "999.5.0" } },
					});
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		const release = await getLatestRelease({ registries: feed });

		expect(urls).toHaveLength(2);
		expect(release.version).toBe("999.5.0");
	});

	it("surfaces a body-read failure on the shortcut instead of retrying the packument", async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) => {
					urls.push(String(input));
					const body = new ReadableStream({
						start(controller) {
							controller.error(new Error("connection reset mid-body"));
						},
					});
					return new Response(body, { status: 200 });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ registries: feed })).rejects.toThrow("connection reset mid-body");
		expect(urls).toHaveLength(1);
	});

	it("reports a missing canary dist-tag on the feed as no canary release", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: FetchInput) =>
					String(input).endsWith("/canary")
						? new Response(null, { status: 404, statusText: "Not Found" })
						: Response.json({ "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { version: "1.0.0" } } }),
				{ preconnect: globalThis.fetch.preconnect },
			),
		);

		await expect(getLatestRelease({ channel: "canary", registries: feed })).rejects.toThrow(
			"No canary release has been published",
		);
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000, registries: npmjs }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
