import { describe, expect, it } from "bun:test";
import { requireArtifactVersion } from "./zcode-artifact";

// The artifact API accepts SemVer, not just the fork's usual stable build tag.
describe("ZCode artifact explicit SemVer contract", () => {
	it.each(["1.2.3-rc.1+fork.9", "0.0.0-alpha+build.0007", "18.12.5+fork.9"])(
		"preserves the complete explicit release version %s",
		version => {
			expect(requireArtifactVersion(version)).toBe(version);
		},
	);

	it.each(["01.2.3", "1.02.3", "1.2.03", "1.2.3-", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+meta..data", "1.2.3+meta."])(
		"rejects non-SemVer release input %s",
		version => {
			expect(() => requireArtifactVersion(version)).toThrow("OMP artifact invalid version");
		},
	);

	it.each([undefined, ""])("never substitutes a package version for missing RELEASE_VERSION %s", version => {
		expect(() => requireArtifactVersion(version)).toThrow("ZCODE_ARTIFACT_ROOT requires RELEASE_VERSION");
	});
});
