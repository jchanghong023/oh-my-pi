/**
 * Gemini CLI Command Adapter
 *
 * Formats commands for Gemini CLI following its TOML specification.
 */
import path from 'path';
import { escapeTomlBasicString, escapeTomlMultilineBasicString } from '../toml.js';
/**
 * Gemini adapter for command generation.
 * File path: .gemini/commands/opsx/<id>.toml
 * Format: TOML with description and prompt fields
 */
export const geminiAdapter = {
    toolId: 'gemini',
    getFilePath(commandId) {
        return path.join('.gemini', 'commands', 'opsx', `${commandId}.toml`);
    },
    formatFile(content) {
        return `description = "${escapeTomlBasicString(content.description)}"

prompt = """
${escapeTomlMultilineBasicString(content.body)}
"""
`;
    },
};
//# sourceMappingURL=gemini.js.map