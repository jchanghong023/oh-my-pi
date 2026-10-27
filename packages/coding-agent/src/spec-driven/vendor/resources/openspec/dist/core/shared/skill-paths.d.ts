import { type AIToolOption } from '../config.js';
export type SkillCapableTool = AIToolOption & ({
    skillsDir: string;
} | {
    globalSkillsDir: string;
});
export declare function toolSupportsSkills(tool: AIToolOption): tool is SkillCapableTool;
export declare function getSkillCapableTools(): SkillCapableTool[];
export declare function hasGlobalSkillTarget(tool: AIToolOption): boolean;
export declare function resolveToolSkillsDir(projectRoot: string, tool: SkillCapableTool, options?: {
    homeDir?: string;
}): string;
//# sourceMappingURL=skill-paths.d.ts.map