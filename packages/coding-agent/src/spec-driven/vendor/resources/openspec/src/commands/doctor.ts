/** Read-only diagnostics for the local OpenSpec project and its directories. */
import { resolveRootForCommand, toRootOutput } from '../core/root-selection.js';
import { emitFailure, printJson } from './shared-output.js';
import { gatherLocalProjectData } from './shared-gather.js';

const FAILURE_PAYLOAD = { root: null };

export interface DoctorOptions {
  json?: boolean;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  try {
    const root = await resolveRootForCommand({
      json: options.json, failurePayload: FAILURE_PAYLOAD, allowImplicitRoot: false,
    });
    if (!root) {
      return;
    }
    const { rootInspection, configPath } = await gatherLocalProjectData(root);
    const health = {
      root: {
        ...toRootOutput(root),
        healthy: rootInspection.healthy,
        status: rootInspection.diagnostics,
      },
      configPath,
    };
    if (options.json) {
      printJson(health);
      return;
    }
    console.log('Doctor');
    console.log('');
    console.log(`  Location: ${root.path}`);
    console.log(`  Configuration: ${configPath}`);
    console.log(`  OpenSpec root: ${rootInspection.healthy ? 'ok' : 'unhealthy'}`);
    for (const entry of rootInspection.diagnostics) {
      console.log(`  - ${entry.message}`);
      if (entry.fix) {
        console.log(`    Fix: ${entry.fix}`);
      }
    }
  } catch (error) {
    emitFailure(options.json, FAILURE_PAYLOAD, error, 'doctor_failed');
  }
}
