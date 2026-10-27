export declare class FileSystemUtils {
    /**
     * Converts a path to use forward slashes (POSIX style).
     * Essential for cross-platform compatibility with glob libraries like tinyglobby.
     */
    static toPosixPath(p: string): string;
    /**
     * Returns a canonical absolute path when the target exists.
     * Falls back to path.resolve() so callers can still produce a stable absolute path.
     */
    static canonicalizeExistingPath(targetPath: string): string;
    /**
     * Refuses a target that leaves an allowed directory, including through an
     * existing symlink in either the target or one of its parent directories.
     * Missing suffixes are resolved from their nearest existing ancestor.
     */
    static assertPathWithin(allowedDirectory: string, targetPath: string): void;
    /**
     * Like assertPathWithin, but a targetPath that is itself a symlink may
     * resolve outside allowedDirectory, so a project can keep a managed
     * directory (for example openspec/changes) in another repository. Its parent
     * must still be confined and the link must resolve to an existing path.
     */
    static assertPathWithinAllowingLinkedLeaf(allowedDirectory: string, targetPath: string): void;
    static resolveProjectArtifactPath(projectPath: string, artifactPath: string): string;
    static assertProjectArtifactPath(projectPath: string, targetPath: string): void;
    private static isPathWithin;
    private static canonicalizePotentialPath;
    private static isWindowsBasePath;
    private static normalizeSegments;
    static joinPath(basePath: string, ...segments: string[]): string;
    static createDirectory(dirPath: string): Promise<void>;
    static fileExists(filePath: string): Promise<boolean>;
    /**
     * Finds the first existing parent directory by walking up the directory tree.
     * @param dirPath Starting directory path
     * @returns The first existing directory path, or null if root is reached without finding one
     */
    private static findFirstExistingDirectory;
    static canWriteFile(filePath: string): Promise<boolean>;
    static directoryExists(dirPath: string): Promise<boolean>;
    static writeFile(filePath: string, content: string): Promise<void>;
    static readFile(filePath: string): Promise<string>;
    static updateFileWithMarkers(filePath: string, content: string, startMarker: string, endMarker: string): Promise<void>;
    static ensureWritePermissions(dirPath: string): Promise<boolean>;
}
/**
 * Removes a marker block from file content.
 * Only removes markers that are on their own lines (ignores inline mentions).
 * Cleans up double blank lines that may result from removal.
 *
 * @param content - File content with markers
 * @param startMarker - The start marker string
 * @param endMarker - The end marker string
 * @returns Content with marker block removed, or original content if markers not found/invalid
 */
export declare function removeMarkerBlock(content: string, startMarker: string, endMarker: string): string;
//# sourceMappingURL=file-system.d.ts.map