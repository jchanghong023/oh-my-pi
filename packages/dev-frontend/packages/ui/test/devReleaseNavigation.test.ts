import { describe, expect, test } from "bun:test";
import { selectionForRelease } from "../src/dev/domain.js";
import type { DevRequirementGroup, DevSelection } from "../src/dev/types.js";

const formal: DevRequirementGroup = {
  id: "formal-ir", projectId: "project", releaseId: "release-one", title: "Formal requirement",
  documentPath: "requirements/formal-ir/proposal.md", origin: "browser", status: "formal", revision: 1,
  srIds: ["formal-sr"], files: [], sessions: [], createdAt: "2026-11-01T00:00:00Z",
};
const proposal: DevRequirementGroup = { ...formal, id: "proposal-ir", status: "draft" };
const view = { groups: [formal], drafts: [proposal] };

describe("Dev release navigation", () => {
  test("clears incompatible formal IR and SR reports without leaving the formal table", () => {
    for (const srId of [undefined, "formal-sr"]) {
      const selection: DevSelection = { projectId: "project", irId: formal.id, srId, formalView: "detail", materialPath: "report.md" };
      expect(selectionForRelease(selection, view, "release-two")).toEqual({ projectId: "project", formalView: "list" });
      expect(selectionForRelease(selection, view, "release-one")).toBe(selection);
    }
  });

  test("preserves formal navigation for restored IR and SR selections without an explicit formalView", () => {
    for (const srId of [undefined, "formal-sr"]) {
      expect(selectionForRelease({ projectId: "project", irId: formal.id, srId }, view, "release-two"))
        .toEqual({ projectId: "project", formalView: "list" });
    }
  });

  test("does not mistake a proposal for a formal requirement", () => {
    const selection: DevSelection = { projectId: "project", irId: proposal.id, proposalStep: "solution" };
    expect(selectionForRelease(selection, view, "release-two")).toEqual({ projectId: "project" });
    expect(selectionForRelease(selection, view, "release-one")).toBe(selection);
  });

  test("leaves formal lists and unselected drafts untouched", () => {
    const selections: DevSelection[] = [
      { projectId: "project", formalView: "list" },
      { projectId: "project", proposalDraftId: "draft", proposalDraftReleaseId: "release-one" },
      { projectId: "project", freeDraftId: "free-draft" },
      { projectId: "project" },
    ];
    for (const selection of selections) expect(selectionForRelease(selection, view, "release-two")).toBe(selection);
  });
});
