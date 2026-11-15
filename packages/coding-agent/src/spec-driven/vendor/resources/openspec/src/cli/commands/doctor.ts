import { Command } from 'commander';
import { COMMAND_REGISTRY } from '../../core/completions/command-registry.js';
import type { DoctorOptions } from '../../commands/doctor.js';

export function registerDoctorCommand(program: Command): void {
  const description =
    COMMAND_REGISTRY.find((entry) => entry.name === 'doctor')?.description ??
    'Report local project configuration and directory health';

  program
    .command('doctor')
    .description(description)
    .option('--json', 'Output as JSON')
    .action(async (options: DoctorOptions) => {
      const { doctorCommand } = await import('../../commands/doctor.js');
      await doctorCommand(options);
    });
}
