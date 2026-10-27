/**
 * CoStrict Command Adapter
 *
 * Formats commands for CoStrict following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * CoStrict adapter for command generation.
 * File path: .cospec/openspec/commands/opsx-<id>.md
 * Frontmatter: description, argument-hint
 */
export const costrictAdapter = {
    toolId: 'costrict',
    getFilePath(commandId) {
        return path.join('.cospec', 'openspec', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
argument-hint: command arguments
---

${content.body}
`;
    },
};
//# sourceMappingURL=costrict.js.map