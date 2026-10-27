/**
 * Static template strings for PowerShell completion scripts.
 * These are PowerShell-specific helper functions that never change.
 */
export declare const POWERSHELL_DYNAMIC_HELPERS = "# Dynamic completion helpers\n\nfunction Get-OpenSpecChanges {\n    $output = openspec __complete changes 2>$null\n    if ($output) {\n        $output | ForEach-Object {\n            ($_ -split \"\\t\")[0]\n        }\n    }\n}\n\nfunction Get-OpenSpecSpecs {\n    $output = openspec __complete specs 2>$null\n    if ($output) {\n        $output | ForEach-Object {\n            ($_ -split \"\\t\")[0]\n        }\n    }\n}\n\nfunction Get-OpenSpecSchemas {\n    $output = openspec __complete schemas 2>$null\n    if ($output) {\n        $output | ForEach-Object {\n            ($_ -split \"\\t\")[0]\n        }\n    }\n}\n";
//# sourceMappingURL=powershell-templates.d.ts.map