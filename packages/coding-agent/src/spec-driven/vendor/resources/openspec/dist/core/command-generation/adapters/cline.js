/**
 * Cline Command Adapter
 *
 * Formats commands for Cline following its workflow specification.
 * Cline uses markdown headers instead of YAML frontmatter.
 */
import path from 'path';
/**
 * Cline adapter for command generation.
 * File path: .clinerules/workflows/opsx-<id>.md
 * Format: Markdown header with description
 */
export const clineAdapter = {
    toolId: 'cline',
    getFilePath(commandId) {
        return path.join('.clinerules', 'workflows', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `# ${content.name}

${content.description}

${content.body}
`;
    },
};
//# sourceMappingURL=cline.js.map