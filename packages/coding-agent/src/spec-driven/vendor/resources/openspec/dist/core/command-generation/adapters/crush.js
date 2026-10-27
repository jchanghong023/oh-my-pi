/**
 * Crush Command Adapter
 *
 * Formats commands for Crush following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue, formatTagsArray } from '../yaml.js';
/**
 * Crush adapter for command generation.
 * File path: .crush/commands/opsx/<id>.md
 * Frontmatter: name, description, category, tags
 */
export const crushAdapter = {
    toolId: 'crush',
    getFilePath(commandId) {
        return path.join('.crush', 'commands', 'opsx', `${commandId}.md`);
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
//# sourceMappingURL=crush.js.map