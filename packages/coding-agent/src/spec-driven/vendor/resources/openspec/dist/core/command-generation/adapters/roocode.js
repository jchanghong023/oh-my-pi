/**
 * Zoo Code Command Adapter
 *
 * Formats commands for Zoo Code following its workflow specification.
 * Zoo Code uses markdown headers instead of YAML frontmatter.
 */
import path from 'path';
/**
 * Zoo Code adapter for command generation.
 * File path: .roo/commands/opsx-<id>.md
 * Format: Markdown header with description
 */
export const roocodeAdapter = {
    toolId: 'roocode',
    getFilePath(commandId) {
        return path.join('.roo', 'commands', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `# ${content.name}

${content.description}

${content.body}
`;
    },
};
//# sourceMappingURL=roocode.js.map