import type { OpenSpecDiagnostic } from './errors.js';
import { toRootOutput, type ResolvedOpenSpecRoot, type RootOutput } from './root-selection.js';

export interface WorkingSet {
  root: RootOutput & { role: 'openspec_root' };
  status: OpenSpecDiagnostic[];
}

export interface AssembleWorkingSetInput {
  root: ResolvedOpenSpecRoot;
  status?: OpenSpecDiagnostic[];
}

export function assembleWorkingSet(input: AssembleWorkingSetInput): WorkingSet {
  return {
    root: { ...toRootOutput(input.root), role: 'openspec_root' },
    status: input.status ?? [],
  };
}

export function buildCodeWorkspaceJson(workingSet: WorkingSet, rootName: string): string {
  return JSON.stringify({
    folders: [{ name: rootName, path: workingSet.root.path }],
  }, null, 2) + '\n';
}
