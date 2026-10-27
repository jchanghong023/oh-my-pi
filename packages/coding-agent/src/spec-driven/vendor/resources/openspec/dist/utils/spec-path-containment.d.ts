/**
 * Containment for a `spec.md` under a trust root already established for it:
 * inside the root, or a link out of the root that stays inside the project.
 *
 * Deliberately does not re-derive a trust root from the file's own capability
 * directory. Callers use this to recheck a path immediately before reading or
 * writing it, and a capability directory swapped for a link since the path was
 * resolved has to be refused rather than trusted afresh.
 */
export declare function assertSpecFileWithin(root: string, specFile: string): void;
/**
 * Containment for a `spec.md` as it is discovered, where the capability
 * directory itself may deliberately be a link into another repository and is
 * then the file's own trust root.
 */
export declare function assertDiscoveredSpecFile(specsRoot: string, specFile: string): void;
//# sourceMappingURL=spec-path-containment.d.ts.map