import { z } from 'zod';
export { isKebabId } from '../id.js';
export declare const InitiativeLinkSchema: z.ZodObject<{
    store: z.ZodString;
    id: z.ZodString;
}, z.core.$strict>;
export type InitiativeLink = z.infer<typeof InitiativeLinkSchema>;
/** Top-level keys ChangeMetadataSchema recognizes. Anything else is ignored. */
export declare const CHANGE_METADATA_KNOWN_KEYS: readonly ["schema", "created", "goal", "affected_areas", "initiative", "skip_specs", "retire_capabilities"];
export type ChangeMetadataKnownKey = (typeof CHANGE_METADATA_KNOWN_KEYS)[number];
export declare const ChangeMetadataSchema: z.ZodObject<{
    schema: z.ZodString;
    created: z.ZodOptional<z.ZodString>;
    goal: z.ZodOptional<z.ZodString>;
    affected_areas: z.ZodOptional<z.ZodArray<z.ZodString>>;
    initiative: z.ZodOptional<z.ZodObject<{
        store: z.ZodString;
        id: z.ZodString;
    }, z.core.$strict>>;
    skip_specs: z.ZodOptional<z.ZodBoolean>;
    retire_capabilities: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type ChangeMetadata = z.infer<typeof ChangeMetadataSchema>;
//# sourceMappingURL=schema.d.ts.map