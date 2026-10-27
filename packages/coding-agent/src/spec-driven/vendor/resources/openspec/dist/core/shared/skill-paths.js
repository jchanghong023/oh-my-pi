import os from 'node:os';
import path from 'node:path';
import { AI_TOOLS } from '../config.js';
export function toolSupportsSkills(tool) {
    return Boolean(tool.skillsDir || tool.globalSkillsDir);
}
export function getSkillCapableTools() {
    return AI_TOOLS.filter(toolSupportsSkills);
}
export function hasGlobalSkillTarget(tool) {
    return Boolean(tool.globalSkillsDir);
}
export function resolveToolSkillsDir(projectRoot, tool, options = {}) {
    if (tool.globalSkillsDir) {
        const homeDir = options.homeDir ?? process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
        return path.join(homeDir, tool.globalSkillsDir, 'skills');
    }
    if (tool.skillsDir) {
        return path.join(projectRoot, tool.skillsDir, 'skills');
    }
    throw new Error(`Tool '${tool.value}' does not support skill generation.`);
}
//# sourceMappingURL=skill-paths.js.map