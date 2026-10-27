/**
 * Validation threshold constants
 */
export declare const MIN_WHY_SECTION_LENGTH = 50;
export declare const MIN_PURPOSE_LENGTH = 50;
export declare const MAX_WHY_SECTION_LENGTH = 1000;
export declare const MAX_REQUIREMENT_TEXT_LENGTH = 500;
export declare const MAX_DELTAS_PER_CHANGE = 10;
export declare const PURPOSE_PLACEHOLDER_PREFIX = "TBD - created by archiving change ";
export declare const PURPOSE_PLACEHOLDER_SUFFIX = ". Update Purpose after archive.";
export declare const VALIDATION_MESSAGES: {
    readonly SCENARIO_EMPTY: "Scenario text cannot be empty";
    readonly REQUIREMENT_EMPTY: "Requirement text cannot be empty";
    readonly REQUIREMENT_NO_SHALL: "Requirement must contain SHALL or MUST keyword";
    readonly REQUIREMENT_NO_SCENARIOS: "Requirement must have at least one scenario";
    readonly SPEC_NAME_EMPTY: "Spec name cannot be empty";
    readonly SPEC_PURPOSE_EMPTY: "Purpose section cannot be empty";
    readonly SPEC_NO_REQUIREMENTS: "Spec must have at least one requirement";
    readonly CHANGE_NAME_EMPTY: "Change name cannot be empty";
    readonly CHANGE_WHY_TOO_SHORT: "Why section must be at least 50 characters";
    readonly CHANGE_WHY_TOO_LONG: "Why section should not exceed 1000 characters";
    readonly CHANGE_WHAT_EMPTY: "What Changes section cannot be empty";
    readonly CHANGE_NO_DELTAS: "Change must have at least one delta";
    readonly CHANGE_SKIP_SPECS_CONFLICT: "skip_specs is set in .openspec.yaml but spec files exist under specs/. Remove skip_specs or delete the delta spec files";
    readonly CHANGE_SKIP_SPECS_ACCEPTED: "skip_specs is set in .openspec.yaml: change declares no spec-level behavior changes, zero deltas accepted";
    readonly CHANGE_SKIP_SPECS_INVALID_METADATA: "skip_specs is set but .openspec.yaml is not valid change metadata, so the marker is not honored. Fix the metadata";
    readonly CHANGE_TOO_MANY_DELTAS: "Consider splitting changes with more than 10 deltas";
    readonly DELTA_SPEC_EMPTY: "Spec name cannot be empty";
    readonly DELTA_DESCRIPTION_EMPTY: "Delta description cannot be empty";
    readonly PURPOSE_TOO_BRIEF: "Purpose section is too brief (less than 50 characters)";
    readonly PURPOSE_IS_PLACEHOLDER: string;
    readonly REQUIREMENT_TOO_LONG: "Requirement text is very long (>500 characters). Move examples and edge cases into scenarios, or split it into separate requirements that each state one behavior.";
    readonly DELTA_DESCRIPTION_TOO_BRIEF: "Delta description is too brief";
    readonly DELTA_MISSING_REQUIREMENTS: "Delta should include requirements";
    readonly GUIDE_NO_DELTAS: "No deltas found. Ensure your change has a specs/ directory with capability folders (e.g. specs/http-server/spec.md) containing .md files that use delta headers (## ADDED/MODIFIED/REMOVED/RENAMED Requirements) and that each requirement includes at least one \"#### Scenario:\" block. If this change intentionally modifies no specs (pure refactor, tooling, docs), set \"skip_specs: true\" in the change's .openspec.yaml instead. Tip: run \"openspec change show <change-id> --json --deltas-only\" to inspect parsed deltas.";
    readonly GUIDE_MISSING_SPEC_SECTIONS: "Missing required sections. Expected headers: \"## Purpose\" and \"## Requirements\". Example:\n## Purpose\n[brief purpose]\n\n## Requirements\n### Requirement: Clear requirement statement\nUsers SHALL ...\n\n#### Scenario: Descriptive name\n- **WHEN** ...\n- **THEN** ...";
    readonly GUIDE_MISSING_CHANGE_SECTIONS: "Missing required sections. Expected headers: \"## Why\" and \"## What Changes\". Ensure deltas are documented in specs/ using delta headers.";
    readonly GUIDE_SCENARIO_FORMAT: "Scenarios must use level-4 headers. Convert bullet lists into:\n#### Scenario: Short name\n- **WHEN** ...\n- **THEN** ...\n- **AND** ...";
};
//# sourceMappingURL=constants.d.ts.map