// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { embeddedAddonFiles, type EmbedOptions } from "../../natives/scripts/embed-native";
import { createBundlePlugins } from "./bundle-plugins";
import { embeddedRelayExtensionFiles } from "./embed-relay-extension";
import { embeddedExportViewerFiles } from "./export-viewer";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { buildOpenWikiResourceText, openWikiResourceFile } from "./openwiki-resources";

/**
 * Optional packages resolved at runtime rather than embedded. Ink loads
 * react-devtools-core only when DEV is enabled and handles its absence; the
 * interactive UI itself remains bundled and does not require devtools.
 */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze([
	"@huggingface/transformers",
	"fastembed",
	"onnxruntime-node",
	"react-devtools-core",
]);

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Optional application version embedded into the standalone executable. */
	readonly buildVersion?: string;
	/** Optional GitHub repository used by binary-only self-updates. */
	readonly updateRepository?: string;
	/**
	 * Native addon target embedded for the runtime loader to extract; `null`
	 * compiles without one (probe builds that never load the addon).
	 */
	readonly native: EmbedOptions | null;
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Optional unmodified Bun executable used as the standalone runtime template. */
	readonly executablePath?: string;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			files: {
				...(options.native ? await embeddedAddonFiles(options.native) : {}),
				...(await embeddedRelayExtensionFiles()),
				...(await embeddedExportViewerFiles()),
				[openWikiResourceFile]: await buildOpenWikiResourceText(),
			},
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
				...(options.buildVersion ? { "process.env.PI_BUILD_VERSION": JSON.stringify(options.buildVersion) } : {}),
				...(options.updateRepository
					? { "process.env.PI_UPDATE_REPOSITORY": JSON.stringify(options.updateRepository) }
					: {}),
			},
			// Precompiled bytecode skips parsing the ~20 MB bundle at boot:
			// `omp --version` 256 ms -> 30 ms on M4 Max (+52 MB binary).
			// Keep import.meta.resolve in bundled dependencies valid under bytecode.
			format: "esm",
			bytecode: true,
			splitting: true,
			// The legacy Pi registry lazily imports every exported module, so side-effect-only
			// modules (e.g. tui `painters/input.ts` and `widgets/input.ts`) become facade chunks
			// holding only identical imports of shared chunks: same content, same hash. Mirror
			// each source path so same-named modules in different directories never collide.
			naming: { chunk: "chunks/[dir]/[name]-[hash].[ext]" },
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: (await createBundlePlugins()).plugins,
			compile: {
				// Bun's process-wide fetch User-Agent default. Any explicit
				// provider fingerprint (Anthropic/Codex OAuth) still wins.
				execArgv: [`--user-agent=${USER_AGENT}`],
				...(options.executablePath
					? { executablePath: options.executablePath }
					: options.target
						? { target: options.target }
						: {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
