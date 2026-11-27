import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { artifactDigest, cachedArtifact, linuxBinary, linuxSdk, viewerDigest, windowsBinary } from "./cnb-build";
import { publicationTitle, releaseVersionFrom } from "./cnb-version";

describe("CNB publication version contract", () => {
	const old = "0.9.0+fork.1";
	const next = "0.9.0+fork.2";
	const shared = { name: `OMP [omp:v${old}]`, assets: [{ name: linuxBinary }, { name: windowsBinary }] };

	test("does not change the rolling title for an SDK or same-version binary", () => {
		expect(publicationTitle(shared, "omp", next, [linuxSdk])).toBeUndefined();
		expect(publicationTitle(shared, "omp", old, [linuxBinary])).toBeUndefined();
	});

	test("requires both rolling binaries when an existing untouched asset would mismatch", () => {
		expect(() => publicationTitle(shared, "omp", next, [linuxBinary])).toThrow(`--tag v${next}`);
		expect(() => publicationTitle({ name: shared.name }, "omp", next, [linuxBinary])).toThrow("both binaries");
		expect(publicationTitle(shared, "omp", next, [linuxBinary, windowsBinary])).toBe(`OMP [omp:v${next}]`);
	});

	test("allows a new rolling binary without a peer or an independently versioned release", () => {
		expect(publicationTitle({ ...shared, assets: [{ name: linuxSdk }] }, "omp", next, [linuxBinary])).toBe(`OMP [omp:v${next}]`);
		expect(publicationTitle({ ...shared, name: "OMP" }, `v${next}`, next, [linuxBinary])).toBeUndefined();
		expect(() => publicationTitle(shared, `v${old}`, next, [linuxBinary])).toThrow("does not match");
		expect(releaseVersionFrom(`v${next}`)).toBe(next);
		expect(() => releaseVersionFrom("1.2.3-01")).toThrow("semantic version");
	});
});

test("a host cache record binds the exact selected artifact and verified viewer metadata", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cnb-contract-"));
	try {
		const file = path.join(dir, linuxSdk);
		const marker = `${file}.json`;
		const entry = { file, marker, name: linuxSdk, key: "build-key" } as const;
		const viewerBytes = Buffer.from("verified viewer");
		const sha = Bun.SHA256.hash(viewerBytes, "hex");
		const manifest = {
			file: `export-viewer-${sha}.js`, size: viewerBytes.length,
			integrity: `sha256-${Buffer.from(sha, "hex").toBase64()}`,
		};
		const viewer = viewerDigest(manifest);
		expect(() => viewerDigest({ ...manifest, integrity: "sha256-wrong" })).toThrow("byte metadata");
		await Bun.write(file, "zip bytes");
		expect(await cachedArtifact(entry, viewer)).toBe(false);
		await Bun.write(marker, JSON.stringify({ key: entry.key, name: entry.name, viewer, artifact: await artifactDigest(file) }));
		// A hit does not require any local viewer build output or the sibling asset.
		expect(await cachedArtifact(entry, viewer)).toBe(true);
		expect(await cachedArtifact({ ...entry, key: "different-build" }, viewer)).toBe(false);
		expect(await cachedArtifact({ ...entry, name: linuxBinary }, viewer)).toBe(false);
		expect(await cachedArtifact(entry, { ...viewer, size: viewer.size + 1 })).toBe(false);
		await Bun.write(file, "bad bytes");
		expect(await cachedArtifact(entry, viewer)).toBe(false);
		await fs.truncate(file, 0);
		expect(await cachedArtifact(entry, viewer)).toBe(false);
		await Bun.write(marker, "invalid JSON");
		expect(await cachedArtifact(entry, viewer)).toBe(false);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
