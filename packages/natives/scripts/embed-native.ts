import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
	containsLegacyVersionSentinel,
	containsVersionStamp,
	VERSION_STAMP_MAGIC,
} from "../native/version-sentinel.js";

const defaultNativeDir = path.join(import.meta.dir, "../native");

/**
 * zstd level for embedded addons. Each addon is its own frame with no
 * container header or timestamp, so identical addon bytes always embed
 * identically and consecutive binaries differ only where the addon did.
 */
export const EMBEDDED_ADDON_ZSTD_LEVEL = 19;

/** Platform/architecture pair whose addons a standalone binary embeds. */
export interface NativeEmbedTarget {
	readonly platform: string;
	readonly arch: string;
	/** Embed only this x64 variant; omitted SDK builds retain both available variants. */
	readonly x64Variant?: "baseline" | "modern";
}

/** Inputs for {@link embeddedAddonFiles}. */
export interface EmbedOptions extends NativeEmbedTarget {
	/** Directory holding the built `pi_natives.*.node` addons; defaults to this package's `native/`. */
	readonly nativeDir?: string;
	/** Release every embedded addon must be stamped with; defaults to this package's version. */
	readonly version?: string;
}

const frameCacheMagic = Buffer.from("OMPZSTD1");
const frameCacheHeaderSize = frameCacheMagic.length + 64;

/** Cache only complete, integrity-checked frames, not addon validation results. */
async function compressedAddon(bytes: Uint8Array): Promise<Uint8Array> {
	const cacheRoot = Bun.env.OMP_BUILD_CACHE_DIR;
	if (!cacheRoot) return Bun.zstdCompress(bytes, { level: EMBEDDED_ADDON_ZSTD_LEVEL });

	const key = createHash("sha256")
		.update(`embedded-addon-zstd-v1\0${Bun.version}\0${Bun.revision}\0${EMBEDDED_ADDON_ZSTD_LEVEL}\0`)
		.update(bytes)
		.digest();
	const cacheDir = path.join(path.resolve(cacheRoot), "embedded-addon-zstd");
	const cacheFile = path.join(cacheDir, `${key.toString("hex")}.frame`);
	try {
		const cached = await fs.readFile(cacheFile);
		const frame = cached.subarray(frameCacheHeaderSize);
		if (
			frame.length > 0 &&
			cached.subarray(0, frameCacheMagic.length).equals(frameCacheMagic) &&
			cached.subarray(8, 40).equals(key) &&
			cached.subarray(40, frameCacheHeaderSize).equals(createHash("sha256").update(frame).digest())
		) {
			return frame;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const frame = await Bun.zstdCompress(bytes, { level: EMBEDDED_ADDON_ZSTD_LEVEL });
	const header = Buffer.allocUnsafe(frameCacheHeaderSize);
	header.set(frameCacheMagic);
	header.set(key, 8);
	header.set(createHash("sha256").update(frame).digest(), 40);
	await fs.mkdir(cacheDir, { recursive: true });
	const temporary = `${cacheFile}.${randomUUID()}.tmp`;
	try {
		const file = await fs.open(temporary, "wx");
		try {
			// Separate writes avoid copying the potentially large frame into a container buffer.
			await file.writeFile(header);
			await file.writeFile(frame);
		} finally {
			await file.close();
		}
		await fs.rename(temporary, cacheFile);
	} finally {
		await fs.rm(temporary, { force: true });
	}
	return frame;
}

/**
 * Build the in-memory `Bun.build({ files })` overrides that embed one target's
 * addons into a standalone binary: one `<addon>.node.zst` zstd frame per addon
 * variant and a replacement for the checked-in null `native/embedded-addon.js`
 * manifest that points at them. Output is a pure function of the addon bytes
 * (no timestamps, no container), which keeps release-to-release binary patches
 * small.
 *
 * Source addons may live outside the checkout. Manifest and frame overrides
 * always use the package's real module directory, without writing generated
 * files there; only an explicitly configured compression cache writes to disk.
 *
 * @throws when no addon exists for the target, or when an addon lacks the
 * `@oh-my-pi/pi-natives@<version>` version stamp and legacy sentinel.
 */
export async function embeddedAddonFiles({
	platform,
	arch,
	x64Variant,
	nativeDir = defaultNativeDir,
	version = packageJson.version,
}: EmbedOptions): Promise<Record<string, string | Uint8Array>> {
	if (x64Variant !== undefined && (arch !== "x64" || (x64Variant !== "baseline" && x64Variant !== "modern"))) {
		throw new Error(`Invalid explicit native x64 variant ${JSON.stringify(x64Variant)} for ${platform}-${arch}.`);
	}
	const platformTag = `${platform}-${arch}`;
	const candidates =
		arch === "x64"
			? [
					{ variant: "modern", filename: `pi_natives.${platformTag}-modern.node` },
					{ variant: "baseline", filename: `pi_natives.${platformTag}-baseline.node` },
				].filter(candidate => x64Variant === undefined || candidate.variant === x64Variant)
			: [{ variant: "default", filename: `pi_natives.${platformTag}.node` }];

	const dir = await fs.realpath(nativeDir);
	// The loader imports the checked-in manifest, not the external addon source directory.
	const embedDir = nativeDir === defaultNativeDir ? dir : await fs.realpath(defaultNativeDir);
	const present = new Set(await fs.readdir(dir));
	const available = await Promise.all(
		candidates
			.filter(candidate => present.has(candidate.filename))
			.map(async candidate => ({ ...candidate, bytes: await fs.readFile(path.join(dir, candidate.filename)) })),
	);
	if (available.length === 0) {
		const expected = candidates.map(candidate => `  - ${candidate.filename}`).join("\n");
		throw new Error(`No native addons found for ${platformTag}. Expected one of:\n${expected}`);
	}
	for (const { filename, bytes } of available) {
		// Pre-stamp addons (npm releases and main builds before the stamp slot)
		// identify their release by the legacy export, which the loader accepts.
		if (!containsVersionStamp(bytes, version) && !containsLegacyVersionSentinel(bytes, version)) {
			const addonPath = path.join(dir, filename);
			throw new Error(
				`Native addon ${addonPath} does not carry the @oh-my-pi/pi-natives@${version} version stamp ` +
					`\`${VERSION_STAMP_MAGIC}${version}\`. Rebuild it (installs stamp automatically), run ` +
					`\`bun scripts/stamp-native-version.ts ${addonPath}\`, or fetch @oh-my-pi/pi-natives-${platformTag}@${version} before embedding.`,
			);
		}
	}

	// Variants compress concurrently on Bun's thread pool.
	const frames = await Promise.all(available.map(({ bytes }) => compressedAddon(bytes)));
	const imports = available.map(
		({ filename }, index) =>
			`import zstdPath${index} from ${JSON.stringify(`./${filename}.zst`)} with { type: "file" };`,
	);
	const files = available.map(
		({ variant, filename, bytes }, index) =>
			`{ variant: ${JSON.stringify(variant)}, filename: ${JSON.stringify(filename)}, size: ${bytes.length}, zstdPath: zstdPath${index} }`,
	);
	const manifest = `${imports.join("\n")}

export const embeddedAddon = {
	platformTag: ${JSON.stringify(platformTag)},
	version: ${JSON.stringify(version)},
	files: [
		${files.join(",\n\t\t")},
	],
};
`;

	const overrides: Record<string, string | Uint8Array> = {};
	available.forEach(({ filename }, index) => {
		overrides[path.join(embedDir, `${filename}.zst`)] = frames[index];
	});
	overrides[path.join(embedDir, "embedded-addon.js")] = manifest;
	return overrides;
}
