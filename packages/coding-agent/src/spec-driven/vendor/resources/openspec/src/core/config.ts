export const OPENSPEC_DIR_NAME = 'openspec';

export const OPENSPEC_SKILL_NAMES = [
  'openspec-explore',
  'openspec-new-change',
  'openspec-continue-change',
  'openspec-apply-change',
  'openspec-update-change',
  'openspec-ff-change',
  'openspec-sync-specs',
  'openspec-archive-change',
  'openspec-bulk-archive-change',
  'openspec-verify-change',
  'openspec-onboard',
  'openspec-propose',
] as const;

export const OPENSPEC_MARKERS = {
  start: '<!-- OPENSPEC:START -->',
  end: '<!-- OPENSPEC:END -->'
};

export interface OpenSpecConfig {
  aiTools: string[];
}

export interface AIToolOption {
  name: string;
  value: string;
  available: boolean;
  successLabel?: string;
  skillsDir?: string; // e.g., '.claude' - /skills suffix per Agent Skills spec
  legacySkillsDirs?: string[]; // Former roots read for detection and migrated after replacement
  searchAliases?: string[]; // Extra single-word terms the init tool picker matches; never displayed
  setupNote?: string; // Manual setup required before the tool picks up generated files; shown after init/update
  requiresIdeRestart?: boolean; // True when slash commands are loaded by an IDE/editor process (a CLI picks them up immediately, so no restart hint — see #1067)
}


export const AI_TOOLS: AIToolOption[] = [
  // The vendored copy supports only the host it ships with. Other assistants'
  // targets, adapters, aliases, and retired ids were removed with the upstream
  // tree; `openspec init` offers this single entry.
  { name: 'Oh My Pi', value: 'oh-my-pi', available: true, successLabel: 'Oh My Pi', skillsDir: '.omp' }
];

