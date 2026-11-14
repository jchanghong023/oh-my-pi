/**
 * Init Command
 *
 * Creates the project planning structure and configuration.
 */

import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import { FileSystemUtils } from '../utils/file-system.js';
import {
  classifyOpenSpecDir,
  MAX_CONTEXT_SIZE,
  readProjectConfig,
  storePointerProblem,
} from './project-config.js';
import { findRepoPlanningRootSync } from './planning-home.js';
import { ANCHORED_OPENSPEC_DIRS, ensureDirectoryAnchor } from './openspec-root.js';
import { OPENSPEC_DIR_NAME } from './config.js';
import { PALETTE } from './styles/palette.js';
import { serializeConfig } from './config-prompts.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_SCHEMA = 'spec-driven';

function formatLanguageContext(language: string): string {
  return [
    `Language: ${language}`,
    `All artifacts must be written in ${language}.`,
    'Keep OpenSpec structural headings and SHALL/MUST keywords in English.',
  ].join('\n');
}

const PROGRESS_SPINNER = {
  interval: 80,
  frames: ['░░░', '▒░░', '▒▒░', '▒▒▒', '▓▒▒', '▓▓▒', '▓▓▓', '▒▓▓', '░▒▓'],
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type InitCommandOptions = {
  language?: string;
};


// -----------------------------------------------------------------------------
// Init Command Class
// -----------------------------------------------------------------------------

export class InitCommand {
  private readonly language?: string;

  constructor(options: InitCommandOptions = {}) {
    this.language = this.normalizeLanguage(options.language);
  }

  async execute(targetPath: string): Promise<void> {
    const projectPath = FileSystemUtils.canonicalizeExistingPath(targetPath);
    const openspecDir = OPENSPEC_DIR_NAME;
    const openspecPath = path.join(projectPath, openspecDir);

    // Validation happens silently in the background
    const extendMode = await this.validate(projectPath, openspecPath);

    // Reject external planning pointers before prompts, migration, or writes.
    const guardRoot = findRepoPlanningRootSync(projectPath);
    if (guardRoot) {
      const { hasPlanningShape, pointer } = classifyOpenSpecDir(guardRoot);
      if (!hasPlanningShape) {
        if (pointer.malformed) {
          throw new Error(
            `The store declaration in ${pointer.filePath} is invalid (` +
              storePointerProblem(pointer.malformed) +
              `). Fix or remove the store: line before running omp openspec init.`
          );
        }
        if (pointer.value !== undefined) {
          throw new Error(
            `This repo's planning is externalized to store '${pointer.value}' (${pointer.filePath}). ` +
              'Run omp openspec init in the store root instead.'
          );
        }
      }
    }

    await this.assertLanguageCanBeApplied(projectPath, openspecPath);

    await this.createDirectoryStructure(openspecPath, extendMode);

    const configStatus = await this.createConfig(openspecPath, extendMode);

    this.#displaySuccessMessage(projectPath, configStatus);
  }

  // ═══════════════════════════════════════════════════════════
  // VALIDATION & SETUP
  // ═══════════════════════════════════════════════════════════

  private async validate(
    projectPath: string,
    openspecPath: string
  ): Promise<boolean> {
    const extendMode = await FileSystemUtils.directoryExists(openspecPath);

    // Check write permissions
    if (!(await FileSystemUtils.ensureWritePermissions(projectPath))) {
      throw new Error(`Insufficient permissions to write to ${projectPath}`);
    }
    return extendMode;
  }

  // ═══════════════════════════════════════════════════════════
  // DIRECTORY STRUCTURE
  // ═══════════════════════════════════════════════════════════

  private async createDirectoryStructure(openspecPath: string, extendMode: boolean): Promise<void> {
    const directories = [
      openspecPath,
      path.join(openspecPath, 'specs'),
      path.join(openspecPath, 'changes'),
      path.join(openspecPath, 'changes', 'archive'),
    ];

    if (extendMode) {
      // In extend mode, just ensure directories exist without spinner
      for (const dir of directories) {
        FileSystemUtils.assertProjectArtifactPath(path.dirname(openspecPath), dir);
        await FileSystemUtils.createDirectory(dir);
      }
      await this.writeGitkeepFiles(openspecPath);
      return;
    }

    const spinner = this.startSpinner('Creating OpenSpec structure...');

    for (const dir of directories) {
      FileSystemUtils.assertProjectArtifactPath(path.dirname(openspecPath), dir);
      await FileSystemUtils.createDirectory(dir);
    }

    await this.writeGitkeepFiles(openspecPath);

    spinner.stopAndPersist({
      symbol: PALETTE.white('▌'),
      text: PALETTE.white('OpenSpec structure created'),
    });
  }

  private async writeGitkeepFiles(openspecPath: string): Promise<void> {
    for (const relativeDir of ANCHORED_OPENSPEC_DIRS) {
      await ensureDirectoryAnchor(path.dirname(openspecPath), relativeDir);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONFIG FILE
  // ═══════════════════════════════════════════════════════════

  private normalizeLanguage(language: string | undefined): string | undefined {
    if (language === undefined) return undefined;

    const normalized = language.trim();
    if (!normalized) {
      throw new Error('The --language option requires a non-empty value.');
    }
    if (/\p{Cc}|\p{Bidi_Control}|[\u200B\u2028\u2029\uFEFF]/u.test(normalized)) {
      throw new Error(
        'The --language option must be a single line without control or invisible formatting characters.'
      );
    }
    const serializedContext = `${formatLanguageContext(normalized)}\n`;
    if (Buffer.byteLength(serializedContext, 'utf8') > MAX_CONTEXT_SIZE) {
      throw new Error(
        `The --language option is too long for OpenSpec's ${MAX_CONTEXT_SIZE / 1024}KB project context limit.`
      );
    }
    return normalized;
  }

  private languageContext(): string | undefined {
    if (!this.language) return undefined;
    return formatLanguageContext(this.language);
  }

  private async assertLanguageCanBeApplied(
    projectPath: string,
    openspecPath: string
  ): Promise<void> {
    const languageContext = this.languageContext();
    if (!languageContext) return;

    const configPath = path.join(openspecPath, 'config.yaml');
    const hasConfig = fs.existsSync(configPath) ||
      fs.existsSync(path.join(openspecPath, 'config.yml'));
    if (!hasConfig) {
      try {
        FileSystemUtils.assertProjectArtifactPath(projectPath, configPath);
      } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : '';
        throw new Error(`Cannot create openspec/config.yaml for --language${reason}`);
      }
      if (!(await FileSystemUtils.canWriteFile(configPath))) {
        throw new Error(
          'Cannot create openspec/config.yaml for --language: the destination is not writable.'
        );
      }
      return;
    }

    const existingContext = readProjectConfig(projectPath)?.context;
    if (existingContext?.includes(languageContext)) return;

    throw new Error(
      '--language does not overwrite an existing OpenSpec config. ' +
      'Add the language instruction to its context field instead.'
    );
  }

  private async createConfig(openspecPath: string, extendMode: boolean): Promise<'created' | 'exists' | 'skipped'> {
    const configPath = path.join(openspecPath, 'config.yaml');
    const configYmlPath = path.join(openspecPath, 'config.yml');
    const configYamlExists = fs.existsSync(configPath);
    const configYmlExists = fs.existsSync(configYmlPath);

    if (configYamlExists || configYmlExists) {
      return 'exists';
    }


    try {
      const yamlContent = serializeConfig({
        schema: DEFAULT_SCHEMA,
        context: this.languageContext(),
      });
      FileSystemUtils.assertProjectArtifactPath(path.dirname(openspecPath), configPath);
      await FileSystemUtils.writeFile(configPath, yamlContent);
      return 'created';
    } catch (error) {
      if (this.language) {
        const reason = error instanceof Error ? `: ${error.message}` : '';
        throw new Error(`Failed to create openspec/config.yaml for --language${reason}`);
      }
      return 'skipped';
    }
  }

  // ═══════════════════════════════════════════════════════════
  // UI & OUTPUT
  // ═══════════════════════════════════════════════════════════

  #displaySuccessMessage(
    projectPath: string,
    configStatus: 'created' | 'exists' | 'skipped'
  ): void {
    console.log();
    console.log(chalk.bold('OpenSpec Setup Complete'));
    // Config status
    if (configStatus === 'created') {
      console.log(`Config: openspec/config.yaml (schema: ${DEFAULT_SCHEMA})`);
    } else if (configStatus === 'exists') {
      // Show actual filename (config.yaml or config.yml)
      const configYaml = path.join(projectPath, OPENSPEC_DIR_NAME, 'config.yaml');
      const configYml = path.join(projectPath, OPENSPEC_DIR_NAME, 'config.yml');
      const configName = fs.existsSync(configYaml) ? 'config.yaml' : fs.existsSync(configYml) ? 'config.yml' : 'config.yaml';
      console.log(`Config: openspec/${configName} (exists)`);
    } else {
      console.log(chalk.dim(`Config: skipped (non-interactive mode)`));
    }


    console.log();
  }

  private startSpinner(text: string) {
    return ora({
      text,
      stream: process.stdout,
      color: 'gray',
      spinner: PROGRESS_SPINNER,
    }).start();
  }

}
