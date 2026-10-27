/**
 * CodeBuddy Command Adapter
 *
 * Formats commands for CodeBuddy following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * CodeBuddy adapter for command generation.
 * File path: .codebuddy/commands/opsx/<id>.md
 * Frontmatter: name, description, argument-hint
 */
export const codebuddyAdapter = {
    toolId: 'codebuddy',
    getFilePath(commandId) {
        return path.join('.codebuddy', 'commands', 'opsx', `${commandId}.md`);
    },
    formatFile(content) {
        return `---
name: ${escapeYamlValue(content.name)}
description: ${escapeYamlValue(content.description)}
argument-hint: "[command arguments]"
---

${content.body}
`;
    },
};
//# sourceMappingURL=codebuddy.js.map