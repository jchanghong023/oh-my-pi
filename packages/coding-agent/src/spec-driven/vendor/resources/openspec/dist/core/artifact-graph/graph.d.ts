import type { Artifact, SchemaYaml, CompletedSet, BlockedArtifacts } from './types.js';
/**
 * Represents an artifact dependency graph.
 * Provides methods for querying build order, ready artifacts, and completion status.
 */
export declare class ArtifactGraph {
    private artifacts;
    private schema;
    /** Artifact id -> its position in the schema's `artifacts:` list. */
    private declarationOrder;
    private constructor();
    /**
     * Orders artifact ids by where the schema declares them.
     *
     * The dependency graph leaves siblings tied - spec-driven's `specs` and
     * `design` both require only `proposal`, so both become ready at the same
     * time. Ties used to be broken alphabetically, which put `design` ahead of
     * `specs` and made the CLI recommend the artifacts in an order that
     * contradicted the schema's own documented sequence
     * (proposal -> specs -> design -> tasks). Breaking ties by declaration order
     * follows the sequence the schema author wrote, for built-in and custom
     * schemas alike, and stays just as deterministic. Ids not in the schema sort
     * last so the comparator stays total.
     */
    private compareByDeclarationOrder;
    /**
     * Creates an ArtifactGraph from a YAML file path.
     */
    static fromYaml(filePath: string): ArtifactGraph;
    /**
     * Creates an ArtifactGraph from YAML content string.
     */
    static fromYamlContent(yamlContent: string): ArtifactGraph;
    /**
     * Creates an ArtifactGraph from a pre-validated schema object.
     */
    static fromSchema(schema: SchemaYaml): ArtifactGraph;
    /**
     * Gets a single artifact by ID.
     */
    getArtifact(id: string): Artifact | undefined;
    /**
     * Gets all artifacts in the graph.
     */
    getAllArtifacts(): Artifact[];
    /**
     * Gets the schema name.
     */
    getName(): string;
    /**
     * Gets the schema version.
     */
    getVersion(): number;
    /**
     * Computes the topological build order using Kahn's algorithm.
     * Returns artifact IDs in the order they should be built.
     */
    getBuildOrder(): string[];
    /**
     * Gets artifacts that are ready to be created (all dependencies completed).
     */
    getNextArtifacts(completed: CompletedSet): string[];
    /**
     * Checks if all artifacts in the graph are completed.
     */
    isComplete(completed: CompletedSet): boolean;
    /**
     * Gets blocked artifacts and their unmet dependencies.
     */
    getBlocked(completed: CompletedSet): BlockedArtifacts;
}
//# sourceMappingURL=graph.d.ts.map