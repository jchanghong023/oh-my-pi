/**
 * Kiro Command Adapter
 *
 * Formats commands for Kiro following its .prompt.md specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Kiro adapter for command generation.
 * File path: .kiro/prompts/opsx-<id>.prompt.md
 * Frontmatter: description
 */
export const kiroAdapter = {
    toolId: 'kiro',
    getFilePath(commandId) {
        return path.join('.kiro', 'prompts', `opsx-${commandId}.prompt.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=kiro.js.map