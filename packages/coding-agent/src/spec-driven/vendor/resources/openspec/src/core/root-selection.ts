import * as path from 'node:path';
import { OpenSpecError, type OpenSpecDiagnostic } from './errors.js';
import {
  findRepoPlanningRootSync,
  resolveCurrentPlanningHomeSync,
  type PlanningHome,
} from './planning-home.js';
import { readProjectConfig } from './project-config.js';

export type OpenSpecRootSource = 'nearest' | 'implicit';

export interface ResolveOpenSpecRootOptions {
  startPath?: string;
  allowImplicitRoot?: boolean;
}

export interface ResolvedOpenSpecRoot {
  path: string;
  changesDir: string;
  specsDir: string;
  archiveDir: string;
  defaultSchema: 'spec-driven';
  source: OpenSpecRootSource;
}

export type RootSelectionDiagnostic = OpenSpecDiagnostic;

export class RootSelectionError extends OpenSpecError {
  constructor(message: string, code: string, options: { target?: string; fix?: string } = {}) {
    super(message, code, options);
    this.name = 'RootSelectionError';
  }
}

export function isRootSelectionError(error: unknown): error is RootSelectionError {
  return error instanceof RootSelectionError;
}

export async function resolveOpenSpecRoot(
  options: ResolveOpenSpecRootOptions = {}
): Promise<ResolvedOpenSpecRoot> {
  const startPath = options.startPath ?? process.cwd();
  const nearestRoot = findRepoPlanningRootSync(startPath);
  if (!nearestRoot && options.allowImplicitRoot === false) {
    throw new RootSelectionError(
      'No OpenSpec root found from the current directory.',
      'no_openspec_root',
      { target: 'openspec.root', fix: 'Run omp openspec init to create a root here.' }
    );
  }
  const rootPath = nearestRoot ?? resolveCurrentPlanningHomeSync({ startPath }).root;
  try {
    readProjectConfig(rootPath);
  } catch (error) {
    if (error instanceof OpenSpecError) {
      throw new RootSelectionError(error.message, error.diagnostic.code, {
        target: error.diagnostic.target,
        fix: error.diagnostic.fix,
      });
    }
    throw error;
  }
  const changesDir = path.join(rootPath, 'openspec', 'changes');
  return {
    path: rootPath,
    changesDir,
    specsDir: path.join(rootPath, 'openspec', 'specs'),
    archiveDir: path.join(changesDir, 'archive'),
    defaultSchema: 'spec-driven',
    source: nearestRoot ? 'nearest' : 'implicit',
  };
}

export interface RootOutput {
  path: string;
  source: OpenSpecRootSource;
}

export function toRootOutput(root: ResolvedOpenSpecRoot): RootOutput {
  return { path: root.path, source: root.source };
}

export function toPlanningHome(root: ResolvedOpenSpecRoot): PlanningHome {
  return {
    kind: 'repo',
    root: root.path,
    changesDir: root.changesDir,
    defaultSchema: root.defaultSchema,
  };
}

export async function resolveRootForCommand(
  options: {
    json?: boolean;
    failurePayload?: Record<string, unknown>;
    allowImplicitRoot?: boolean;
  } = {}
): Promise<ResolvedOpenSpecRoot | null> {
  try {
    return await resolveOpenSpecRoot({ allowImplicitRoot: options.allowImplicitRoot });
  } catch (error) {
    if (options.json && isRootSelectionError(error)) {
      console.log(JSON.stringify(
        { ...(options.failurePayload ?? {}), status: [error.diagnostic] }, null, 2
      ));
      process.exitCode = 1;
      return null;
    }
    throw error;
  }
}
