/**
 * Qoder Command Adapter
 *
 * Formats commands for Qoder following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue, formatTagsArray } from '../yaml.js';
/**
 * Qoder adapter for command generation.
 * File path: .qoder/commands/opsx/<id>.md
 * Frontmatter: name, description, category, tags
 */
export const qoderAdapter = {
    toolId: 'qoder',
    getFilePath(commandId) {
        return path.join('.qoder', 'commands', 'opsx', `${commandId}.md`);
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
//# sourceMappingURL=qoder.js.map