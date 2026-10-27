/**
 * iFlow Command Adapter
 *
 * Formats commands for iFlow following its frontmatter specification.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
/**
 * iFlow adapter for command generation.
 * File path: .iflow/commands/opsx-<id>.md
 * Frontmatter: name, id, category, description
 */
export const iflowAdapter = {
    toolId: 'iflow',
    getFilePath(commandId) {
        return path.join('.iflow', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
name: ${escapeYamlValue(`/opsx-${content.id}`)}
id: ${escapeYamlValue(`opsx-${content.id}`)}
category: ${escapeYamlValue(content.category)}
description: ${escapeYamlValue(content.description)}
---

${content.body}
`;
    },
};
//# sourceMappingURL=iflow.js.map