/** Local project configuration and directory inspection shared by context and doctor. */
import * as path from 'node:path';

import {
  readProjectConfig,
  resolveConfigFilePath,
  type ProjectConfig,
} from '../core/project-config.js';
import { inspectOpenSpecRoot, type OpenSpecRootInspection } from '../core/openspec-root.js';
import type { ResolvedOpenSpecRoot } from '../core/root-selection.js';

export interface LocalProjectData {
  projectConfig: ProjectConfig | null;
  configPath: string;
  rootInspection: OpenSpecRootInspection;
}

export async function gatherLocalProjectData(
  root: ResolvedOpenSpecRoot
): Promise<LocalProjectData> {
  const projectConfig = readProjectConfig(root.path);
  const configPath =
    resolveConfigFilePath(root.path) ?? path.join(root.path, 'openspec', 'config.yaml');
  const rootInspection = await inspectOpenSpecRoot(root.path);
  return { projectConfig, configPath, rootInspection };
}
