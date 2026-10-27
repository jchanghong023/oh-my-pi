/**
 * Code Studio Command Adapter
 *
 * Formats commands for Syncfusion Code Studio following its .prompt.md specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Code Studio adapter for command generation.
 * File path: .codestudio/prompts/opsx-<id>.prompt.md
 * Frontmatter: description
 */
export const codeStudioAdapter = {
    toolId: 'codestudio',
    getFilePath(commandId) {
        return path.join('.codestudio', 'prompts', `opsx-${commandId}.prompt.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=codestudio.js.map