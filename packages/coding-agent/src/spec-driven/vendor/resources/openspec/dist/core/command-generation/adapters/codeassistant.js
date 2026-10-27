/**
 * SourceCraft Code Assistant Command Adapter
 *
 * Formats commands for the SourceCraft Code Assistant VS Code extension.
 *
 * @see https://sourcecraft.dev/portal/docs/en/code-assistant/operations/agent/slash-commands
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * SourceCraft Code Assistant adapter for command generation.
 * File path: .codeassistant/commands/opsx-<id>.md
 * Format: YAML frontmatter with description
 */
export const codeassistantAdapter = {
    toolId: 'codeassistant',
    getFilePath(commandId) {
        return path.join('.codeassistant', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=codeassistant.js.map