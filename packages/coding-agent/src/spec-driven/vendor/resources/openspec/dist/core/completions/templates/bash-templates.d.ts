/**
 * Static template strings for Bash completion scripts.
 * These are Bash-specific helper functions that never change.
 */
export declare const BASH_DYNAMIC_HELPERS = "# Dynamic completion helpers\n\n_openspec_complete_changes() {\n  local changes\n  changes=$(openspec __complete changes 2>/dev/null | cut -f1)\n  COMPREPLY=($(compgen -W \"$changes\" -- \"$cur\"))\n}\n\n_openspec_complete_specs() {\n  local specs\n  specs=$(openspec __complete specs 2>/dev/null | cut -f1)\n  COMPREPLY=($(compgen -W \"$specs\" -- \"$cur\"))\n}\n\n_openspec_complete_items() {\n  local items\n  items=$(openspec __complete changes 2>/dev/null | cut -f1; openspec __complete specs 2>/dev/null | cut -f1)\n  COMPREPLY=($(compgen -W \"$items\" -- \"$cur\"))\n}\n\n_openspec_complete_schemas() {\n  local schemas\n  schemas=$(openspec __complete schemas 2>/dev/null | cut -f1)\n  COMPREPLY=($(compgen -W \"$schemas\" -- \"$cur\"))\n}";
//# sourceMappingURL=bash-templates.d.ts.map