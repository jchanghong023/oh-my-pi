// Narrow utils test double for emitted-asset resolution probes. The parser
// and packaged changelog are real; profile paths and logging are not part
// of the boundary under test.
export const getLastChangelogVersionPath = (): string => "";
export const isEnoent = (error: unknown): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
export const logger = { error: () => {}, warn: () => {} };
