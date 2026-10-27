/**
 * Antigravity Command Adapter
 *
 * Formats commands for Antigravity following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Antigravity adapter for command generation.
 * File path: .agents/workflows/opsx-<id>.md
 * Frontmatter: description
 */
export const antigravityAdapter = {
    toolId: 'antigravity',
    getFilePath(commandId) {
        return path.join('.agents', 'workflows', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=antigravity.js.map