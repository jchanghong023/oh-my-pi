// Deep import: the pi-utils barrel loads the host native addon, which is
// absent on cross-compiling release runners.
import { USER_AGENT } from "@oh-my-pi/pi-utils/dirs";
import { embeddedAddonFiles, type EmbedOptions } from "../../natives/scripts/embed-native";
import {
	buildDeveloperTestAgentResources,
	createDeveloperTestAgentArchivePlugin,
} from "./developer-test-agent-resources";
import {
	buildDevWorkbenchAssets,
	createDevWorkbenchAssetsPlugin,
	writeDevWorkbenchAssets,
} from "./dev-workbench-resources";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";
import { buildOpenWikiResources, createOpenWikiVisualArchivePlugin } from "./openwiki-resources";
import { createOpenWikiVendorLoaderPlugin } from "./openwiki-vendor-loader-plugin";
import { buildSpecDrivenArchive, createSpecDrivenArchivePlugin } from "./spec-driven-resources";
import { withChargedActivity, withCompilerActivity } from "../../../scripts/test-gate-events";

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
		const openWikiResources = await buildOpenWikiResources();
		const workbenchAssets = await buildDevWorkbenchAssets();
		await writeDevWorkbenchAssets(workbenchAssets);
		const buildOptions: Bun.BuildConfig = {
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			files: options.native ? await embeddedAddonFiles(options.native) : {},
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_OPENWIKI_SKILLS": JSON.stringify(JSON.stringify(openWikiResources.skills)),
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
			// Discovery entry chunks can share a hash; include their source names to avoid collisions.
			naming: { chunk: "chunks/[name]-[hash].[ext]" },
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: [
				createJsonParsePlugin(),
				createOpenWikiVisualArchivePlugin(openWikiResources.visual),
				createDeveloperTestAgentArchivePlugin(await buildDeveloperTestAgentResources()),
				createOpenWikiVendorLoaderPlugin(),
				await createLegacyPiVirtualModulePlugin(),
				createSpecDrivenArchivePlugin(await buildSpecDrivenArchive()),
				createDevWorkbenchAssetsPlugin(workbenchAssets),
			],
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
		};
		// A cross-runtime template may be downloaded inside Bun.build itself;
		// no supported API boundary separates that download from compilation.
		const compilerOnly = options.target === undefined || options.executablePath !== undefined;
		if (!compilerOnly && process.env.OMP_GATE_EVENT_TOKEN) {
			console.warn("UNVERIFIED_COMPILATION_ACCOUNTING: cross-target Bun runtime preparation remains charged");
		}
		const output = compilerOnly
			? await withCompilerActivity(() => Bun.build(buildOptions))
			: await withChargedActivity(() => Bun.build(buildOptions));
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
