import { type OpenerChoice, type OpenerDefinition } from '../core/openers.js';
import { type Workset } from '../core/worksets.js';
export interface ComposeInput {
    memberFlags: string[];
    tool?: string;
}
export declare function composeInteractively(givenName: string | undefined, input: ComposeInput, table: OpenerDefinition[]): Promise<Workset>;
export declare function promptToolFromChoices(available: OpenerChoice[]): Promise<string>;
export declare function promptOpenNow(label: string): Promise<boolean>;
/** Prints the workset (decision 13: remove shows what it removes). */
export declare function confirmRemoveInteractively(workset: Workset): Promise<boolean>;
//# sourceMappingURL=workset-prompts.d.ts.map