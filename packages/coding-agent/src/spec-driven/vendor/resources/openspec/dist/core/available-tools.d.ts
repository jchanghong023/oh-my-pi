/**
 * Available Tools Detection
 *
 * Detects which AI tools are available in a project by scanning
 * for their configuration directories.
 */
import { type AIToolOption } from './config.js';
import { type FileView } from './file-view.js';
/**
 * Scans the project path for AI tool configuration directories and returns
 * the tools that are present.
 *
 * For tools with `detectionPaths`, checks those specific paths (files or
 * directories). Otherwise checks the project's `skillsDir`, or managed skill
 * files in the user's home directory for a global skill target.
 */
export declare function getAvailableTools(projectPath: string, view?: FileView): AIToolOption[];
//# sourceMappingURL=available-tools.d.ts.map