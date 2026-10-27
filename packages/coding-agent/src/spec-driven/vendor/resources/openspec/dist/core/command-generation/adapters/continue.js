/**
 * Continue Command Adapter
 *
 * Formats commands for Continue following its .prompt specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * Continue adapter for command generation.
 * File path: .continue/prompts/opsx-<id>.prompt
 * Frontmatter: name, description, invokable
 */
export const continueAdapter = {
    toolId: 'continue',
    getFilePath(commandId) {
        return path.join('.continue', 'prompts', `opsx-${commandId}.prompt`);
    },
    formatFile(content) {
        // Continue injects an invoked prompt into the model context. Smaller local
        // models can otherwise mistake the workflow name for a tool to call (#925).
        return `---
name: ${escapeYamlValue(`opsx-${content.id}`)}
description: ${escapeYamlValue(content.description)}
invokable: true
---

This workflow prompt is already active. Follow its instructions directly. Do not call a tool named after this workflow.

${content.body}
`;
    },
};
//# sourceMappingURL=continue.js.map