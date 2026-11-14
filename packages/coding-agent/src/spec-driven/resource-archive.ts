// Source execution reads the prepared dist archive; build plugins replace this module with the archive asset.
const archive: { path: string; sha256: string; sourceFingerprint: string } | undefined = undefined;
export default archive;
