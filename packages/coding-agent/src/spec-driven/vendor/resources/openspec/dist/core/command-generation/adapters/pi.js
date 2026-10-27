/**
 * Pi Command Adapter
 *
 * Formats commands for Pi (pi.dev) following its prompt template specification.
 * Pi prompt templates live in .pi/prompts/*.md with description frontmatter.
 */
import path from 'path';
import { escapeYamlValue } from '../yaml.js';
const PI_INPUT_HEADING = /^\*\*Input\*\*:[^\n]*$/m;
function injectPiArgs(body) {
    if (body.includes('$@') || body.includes('$ARGUMENTS')) {
        return body;
    }
    return body.replace(PI_INPUT_HEADING, (heading) => `${heading}\n**Provided arguments**: $@`);
}
/**
 * Pi adapter for prompt template generation.
 * File path: .pi/prompts/opsx-<id>.md
 * Frontmatter: description
 *
 * Pi uses the filename (minus .md) as the slash command name, so
 * opsx-propose.md → /opsx-propose. generateCommand rewrites the body's
 * command references to that form before this adapter formats it.
 */
export const piAdapter = {
    toolId: 'pi',
    getFilePath(commandId) {
        return path.join('.pi', 'prompts', `opsx-${commandId}.md`);
    },
    formatFile(content) {
        return `---
description: ${escapeYamlValue(content.description)}
---

${injectPiArgs(content.body)}
`;
    },
};
//# sourceMappingURL=pi.js.map