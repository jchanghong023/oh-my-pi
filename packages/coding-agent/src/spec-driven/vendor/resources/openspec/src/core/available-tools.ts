/**
 * Available Tools Detection
 *
 * Detects the host AI tool in a project by scanning for its configuration
 * directory. The vendored copy knows a single target, so the generic
 * detection-path and home-directory probes the upstream tree carried for other
 * assistants are gone.
 */

import path from 'path';
import { AI_TOOLS, type AIToolOption } from './config.js';
import { readSkillToolList } from './shared-skill-target.js';
import { isListedToolPresent } from './shared/tool-detection.js';
import { toolSupportsSkills, usesSharedSkills } from './shared/skill-paths.js';
import { DISK_VIEW, type FileView } from './file-view.js';

/**
 * Scans the project path for the tool's configuration directory and returns
 * the tools that are present.
 *
 * A tool's own folder (`.omp`) is evidence it is set up. A tool listed in
 * `.agents/skills/.openspec-target` is present even when only the shared
 * skills folder exists.
 */
export function getAvailableTools(projectPath: string, view: FileView = DISK_VIEW): AIToolOption[] {
  const listed = readSkillToolList(projectPath, view);
  return AI_TOOLS.filter((tool) => {
    if (!toolSupportsSkills(tool)) return false;
    const ownPath = Boolean(tool.skillsDir) && view.isDirectory(path.join(projectPath, tool.skillsDir!));
    return ownPath || (usesSharedSkills(tool) && listed.includes(tool.value) && isListedToolPresent(projectPath, tool.value, view));
  });
}
