// Extracted from jchanghong023/OmpCode at c7c190724f3a00a2de998a0a5511201d5a2ba1a0.
// vendor/ preserves packages/shared/src layout and the complete public V4 +
// legacy dependency closure. No runtime import crosses repositories.
export const ZCODE_SCHEMA_SOURCE = {
	repository: "https://github.com/jchanghong023/OmpCode",
	commit: "c7c190724f3a00a2de998a0a5511201d5a2ba1a0",
	paths: [
		"packages/shared/src/zcode-protocol-v4/index.ts",
		"packages/shared/src/zcode-protocol/index.ts",
		"packages/shared/src/session-debug.ts",
	],
} as const;
export * from "./vendor/zcode-protocol-v4/index";
export * as LegacyProtocol from "./vendor/zcode-protocol/index";
export * from "./omp-config-extension";
export * from "./vendor/session-debug";
