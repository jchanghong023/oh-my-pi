import { z } from 'zod';
export declare const ArtifactSchema: z.ZodObject<{
    id: z.ZodString;
    generates: z.ZodString;
    description: z.ZodString;
    template: z.ZodString;
    instruction: z.ZodOptional<z.ZodString>;
    requires: z.ZodDefault<z.ZodArray<z.ZodString>>;
}, z.core.$strip>;
export declare const ApplyPhaseSchema: z.ZodObject<{
    requires: z.ZodArray<z.ZodString>;
    tracks: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    instruction: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const SchemaYamlSchema: z.ZodObject<{
    name: z.ZodString;
    version: z.ZodNumber;
    description: z.ZodOptional<z.ZodString>;
    artifacts: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        generates: z.ZodString;
        description: z.ZodString;
        template: z.ZodString;
        instruction: z.ZodOptional<z.ZodString>;
        requires: z.ZodDefault<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>>;
    apply: z.ZodOptional<z.ZodObject<{
        requires: z.ZodArray<z.ZodString>;
        tracks: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        instruction: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type ApplyPhase = z.infer<typeof ApplyPhaseSchema>;
export type SchemaYaml = z.infer<typeof SchemaYamlSchema>;
export type CompletedSet = Set<string>;
export interface BlockedArtifacts {
    [artifactId: string]: string[];
}
//# sourceMappingURL=types.d.ts.map