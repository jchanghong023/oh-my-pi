/**
 * Returns the ids of active changes: every directory under openspec/changes/
 * except the archive and hidden directories.
 *
 * A change is resolved by its directory alone - the same rule `list`,
 * `status`, `instructions` and `validate` use (`getAvailableChanges`).
 * Requiring proposal.md here made `openspec show` and shell completion miss
 * changes those commands resolve: `openspec new change <name>` scaffolds only
 * `.openspec.yaml`, and a custom schema need not define a proposal artifact at
 * all (#1161).
 */
export declare function getActiveChangeIds(root?: string): Promise<string[]>;
export declare function getSpecIds(root?: string): Promise<string[]>;
/**
 * Returns the ids of archived changes: every directory under
 * openspec/changes/archive/ except hidden directories.
 *
 * Resolved by directory for the same reason as `getActiveChangeIds`: a change
 * archived from a schema without a proposal artifact has no proposal.md, and
 * gating on it hid those entries from shell completion.
 */
export declare function getArchivedChangeIds(root?: string): Promise<string[]>;
//# sourceMappingURL=item-discovery.d.ts.map