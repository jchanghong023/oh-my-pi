/** Local project context, optionally written as an editor workspace. */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  resolveRootForCommand,
  type ResolvedOpenSpecRoot,
} from '../core/root-selection.js';
import {
  assembleWorkingSet,
  buildCodeWorkspaceJson,
  type WorkingSet,
} from '../core/working-set.js';
import { OpenSpecError } from '../core/errors.js';
import { emitFailure, printJson } from './shared-output.js';
import { gatherLocalProjectData } from './shared-gather.js';

const FAILURE_PAYLOAD = { root: null };

async function gatherWorkingSet(root: ResolvedOpenSpecRoot): Promise<WorkingSet> {
  const data = await gatherLocalProjectData(root);
  return assembleWorkingSet({ root, status: data.rootInspection.diagnostics });
}

function printHumanWorkingSet(workingSet: WorkingSet): void {
  console.log(`Working context for ${path.basename(workingSet.root.path)} (${workingSet.root.path})`);
  console.log('');
  console.log('OpenSpec root');
  console.log(`  ${workingSet.root.path}`);
  for (const diagnostic of workingSet.status) {
    console.log(`  Note: ${diagnostic.message}`);
    if (diagnostic.fix) {
      console.log(`  Fix: ${diagnostic.fix}`);
    }
  }
}

function writeCodeWorkspace(
  workingSet: WorkingSet,
  outputPath: string,
  force: boolean
): void {
  const resolved = path.resolve(outputPath);
  if (fs.existsSync(resolved) && !force) {
    throw new OpenSpecError(
      `Refusing to overwrite ${resolved}.`,
      'context_file_exists',
      {
        target: 'context.output',
        fix: `Pass --force to overwrite, or choose a different path.`,
      }
    );
  }
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new OpenSpecError(
      `Output directory does not exist: ${parent}.`,
      'context_output_dir_missing',
      { target: 'context.output', fix: 'Create the directory first, or choose another path.' }
    );
  }

  const rootName = path.basename(workingSet.root.path);
  fs.writeFileSync(resolved, buildCodeWorkspaceJson(workingSet, rootName));
  // stderr keeps JSON stdout pure; for humans it reads inline.
  console.error(`Wrote ${resolved} (1 folder)`);
}

export interface ContextOptions {
  json?: boolean;
  codeWorkspace?: string;
  force?: boolean;
}

export async function contextCommand(options: ContextOptions): Promise<void> {
  try {
    const root = await resolveRootForCommand({
      json: options.json, failurePayload: FAILURE_PAYLOAD, allowImplicitRoot: false,
    });
    if (!root) {
      return;
    }

    const workingSet = await gatherWorkingSet(root);

    if (options.json) {
      // The write runs FIRST: a write failure must leave stdout
      // holding exactly one JSON document (the failure payload).
      if (options.codeWorkspace) {
        writeCodeWorkspace(workingSet, options.codeWorkspace, options.force === true);
      }
      printJson(workingSet);
    } else {
      printHumanWorkingSet(workingSet);
      if (options.codeWorkspace) {
        writeCodeWorkspace(workingSet, options.codeWorkspace, options.force === true);
      }
    }
  } catch (error) {
    emitFailure(options.json, FAILURE_PAYLOAD, error, 'context_failed');
  }
}
