/**
 * Trae Command Adapter
 *
 * Formats commands for Trae IDE following its command specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Trae adapter for command generation.
 * File path: .trae/commands/opsx-<id>.md
 * Frontmatter: name, description
 */
export const traeAdapter = {
    toolId: 'trae',
    getFilePath(commandId) {
        return path.join('.trae', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
name: ${escapeYamlValue(content.name)}
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=trae.js.map