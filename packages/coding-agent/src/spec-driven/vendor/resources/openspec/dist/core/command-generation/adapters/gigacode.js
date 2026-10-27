/**
 * GigaCode Command Adapter
 *
 * Formats commands for GigaCode using its Markdown custom command format.
 * Project commands live in `.gigacode/commands/` and accept an optional
 * `description` field in YAML frontmatter.
 *
 * @see https://gitverse.ru/docs/ai/ai-assistant-gigacode/gigacode-cli/commands
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * GigaCode adapter for command generation.
 * File path: .gigacode/commands/opsx-<id>.md
 * Format: Markdown with description frontmatter
 */
export const gigacodeAdapter = {
    toolId: 'gigacode',
    getFilePath(commandId) {
        return path.join('.gigacode', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=gigacode.js.map