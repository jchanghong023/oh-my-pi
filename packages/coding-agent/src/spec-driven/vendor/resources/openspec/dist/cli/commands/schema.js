/**
 * Register the schema command and all its subcommands.
 */
export function registerSchemaCommand(program) {
    const schemaCmd = program
        .command('schema')
        .description('Manage workflow schemas [experimental]');
    // Experimental warning
    schemaCmd.hook('preAction', () => {
        console.error('Note: Schema commands are experimental and may change.');
    });
    // schema which
    schemaCmd
        .command('which [name]')
        .description('Show where a schema resolves from')
        .option('--json', 'Output as JSON')
        .option('--all', 'List all schemas with their resolution sources')
        .action(async (name, options) => {
        const { schemaWhichCommand } = await import('../../commands/schema.js');
        await schemaWhichCommand(name, options);
    });
    // schema validate
    schemaCmd
        .command('validate [name]')
        .description('Validate a schema structure and templates')
        .option('--json', 'Output as JSON')
        .option('--verbose', 'Show detailed validation steps')
        .action(async (name, options) => {
        const { schemaValidateCommand } = await import('../../commands/schema.js');
        await schemaValidateCommand(name, options);
    });
    // schema fork
    schemaCmd
        .command('fork <source> [name]')
        .description('Copy an existing schema to project for customization')
        .option('--json', 'Output as JSON')
        .option('--force', 'Overwrite existing destination')
        .action(async (source, name, options) => {
        const { schemaForkCommand } = await import('../../commands/schema.js');
        await schemaForkCommand(source, name, options);
    });
    // schema init
    schemaCmd
        .command('init <name>')
        .description('Create a new project-local schema')
        .option('--json', 'Output as JSON')
        .option('--description <text>', 'Schema description')
        .option('--artifacts <list>', 'Comma-separated artifact IDs (proposal,specs,design,tasks)')
        .option('--default', 'Set as project default schema')
        .option('--no-default', 'Do not prompt to set as default')
        .option('--force', 'Overwrite existing schema')
        .action(async (name, options) => {
        const { schemaInitCommand } = await import('../../commands/schema.js');
        await schemaInitCommand(name, options);
    });
}
//# sourceMappingURL=schema.js.map