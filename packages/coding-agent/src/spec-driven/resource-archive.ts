import type { SpecDrivenArchiveKind } from "./resource-manifest";

interface ResourceAsset {
	path: string;
	sha256: string;
	sourceFingerprint: string;
}

// Source execution reads the prepared dist assets; distribution builds replace this module.
const archive: Readonly<Record<SpecDrivenArchiveKind, ResourceAsset>> | undefined = undefined;
export default archive;
