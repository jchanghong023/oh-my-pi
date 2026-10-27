/**
 * Skill Generation Utilities
 *
 * Shared utilities for generating skill and command files.
 */
import { getOpsxExploreCommandTemplate, type SkillTemplate } from '../templates/skill-templates.js';
import type { CommandContent } from '../command-generation/index.js';
/**
 * Skill template with directory name and workflow ID mapping.
 */
export interface SkillTemplateEntry {
    template: SkillTemplate;
    dirName: string;
    workflowId: string;
}
/**
 * Command template with ID mapping.
 */
export interface CommandTemplateEntry {
    template: ReturnType<typeof getOpsxExploreCommandTemplate>;
    id: string;
}
/**
 * Gets skill templates with their directory names, optionally filtered by workflow IDs.
 *
 * @param workflowFilter - If provided, only return templates whose workflowId is in this array
 */
export declare function getSkillTemplates(workflowFilter?: readonly string[]): SkillTemplateEntry[];
/**
 * Gets command templates with their IDs, optionally filtered by workflow IDs.
 *
 * @param workflowFilter - If provided, only return templates whose id is in this array
 */
export declare function getCommandTemplates(workflowFilter?: readonly string[]): CommandTemplateEntry[];
/**
 * Converts command templates to CommandContent array, optionally filtered by workflow IDs.
 *
 * @param workflowFilter - If provided, only return contents whose id is in this array
 */
export declare function getCommandContents(workflowFilter?: readonly string[]): CommandContent[];
/**
 * Generates skill file content with YAML frontmatter.
 *
 * @param template - The skill template
 * @param generatedByVersion - The OpenSpec version to embed in the file
 * @param transformInstructions - Optional callback to transform the instructions content
 */
export declare function generateSkillContent(template: SkillTemplate, generatedByVersion: string, transformInstructions?: (instructions: string) => string): string;
//# sourceMappingURL=skill-generation.d.ts.map