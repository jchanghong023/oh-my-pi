/**
 * ZCode Command Adapter
 *
 * Formats commands for ZCode following its frontmatter specification.
 * ZCode shares Claude Code's command format conventions.
 * File path: .zcode/commands/opsx/<id>.md
 * Frontmatter: name, description, category, tags
 */
import path from 'path';
import { escapeYamlValue, formatTagsArray } from '../yaml.js';
/**
 * ZCode adapter for command generation.
 * File path: .zcode/commands/opsx/<id>.md
 * Frontmatter: name, description, category, tags
 */
export const zcodeAdapter = {
    toolId: 'zcode',
    getFilePath(commandId) {
        return path.join('.zcode', 'commands', 'opsx', `${commandId}.md`);
    },
    formatFile(content) {
        return `---
name: ${escapeYamlValue(content.name)}
description: ${escapeYamlValue(content.description)}
category: ${escapeYamlValue(content.category)}
tags: ${formatTagsArray(content.tags)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=zcode.js.map