import { type StoreDiagnostic } from './store/errors.js';
export declare const OPENSPEC_ROOT_DIR = "openspec";
export declare const OPENSPEC_CONFIG_YAML = "openspec/config.yaml";
export declare const OPENSPEC_CONFIG_YML = "openspec/config.yml";
export declare const OPENSPEC_SPECS_DIR = "openspec/specs";
export declare const OPENSPEC_CHANGES_DIR = "openspec/changes";
export declare const OPENSPEC_ARCHIVE_DIR = "openspec/changes/archive";
export declare const DEFAULT_OPENSPEC_SCHEMA = "spec-driven";
export declare const DIRECTORY_ANCHOR_FILE_NAME = ".gitkeep";
export declare const ANCHORED_OPENSPEC_DIRS: readonly ["openspec/specs", "openspec/changes/archive"];
export interface CreatedPathLedgerEntry {
    relativePath: string;
    absolutePath: string;
    kind: 'directory' | 'file';
}
export interface OpenSpecRootInspection {
    present: boolean | null;
    config: {
        present: boolean | null;
        path?: string;
    };
    specs: {
        present: boolean | null;
    };
    changes: {
        present: boolean | null;
    };
    archive: {
        present: boolean | null;
    };
    healthy: boolean;
    diagnostics: StoreDiagnostic[];
}
export interface EnsureOpenSpecRootResult {
    inspection: OpenSpecRootInspection;
    createdArtifacts: string[];
    createdPaths: CreatedPathLedgerEntry[];
}
export declare function inspectOpenSpecRoot(storeRoot: string): Promise<OpenSpecRootInspection>;
export declare function ensureDirectoryAnchor(storeRoot: string, relativeDir: string, ledger?: CreatedPathLedgerEntry[]): Promise<void>;
export interface EnsureOpenSpecRootOptions {
    anchorEmptyDirectories?: boolean;
}
export declare function ensureOpenSpecRoot(storeRoot: string, options?: EnsureOpenSpecRootOptions): Promise<EnsureOpenSpecRootResult>;
export declare function rollbackCreatedPaths(entries: CreatedPathLedgerEntry[]): Promise<void>;
//# sourceMappingURL=openspec-root.d.ts.map