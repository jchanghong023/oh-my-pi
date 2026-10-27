/**
 * Lingma Command Adapter
 *
 * Formats commands for Lingma following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue, formatTagsArray } from '../yaml.js';
/**
 * Lingma adapter for command generation.
 * File path: .lingma/commands/opsx/<id>.md
 * Frontmatter: name, description, category, tags
 */
export const lingmaAdapter = {
    toolId: 'lingma',
    getFilePath(commandId) {
        return path.join('.lingma', 'commands', 'opsx', `${commandId}.md`);
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
//# sourceMappingURL=lingma.js.map