import { ZshGenerator } from './generators/zsh-generator.js';
import { BashGenerator } from './generators/bash-generator.js';
import { FishGenerator } from './generators/fish-generator.js';
import { PowerShellGenerator } from './generators/powershell-generator.js';
import { ZshInstaller } from './installers/zsh-installer.js';
import { BashInstaller } from './installers/bash-installer.js';
import { FishInstaller } from './installers/fish-installer.js';
import { PowerShellInstaller } from './installers/powershell-installer.js';
/**
 * Factory for creating completion generators and installers
 * This design makes it easy to add support for additional shells
 */
export class CompletionFactory {
    static SUPPORTED_SHELLS = ['zsh', 'bash', 'fish', 'powershell'];
    /**
     * Create a completion generator for the specified shell
     *
     * @param shell - The target shell
     * @returns CompletionGenerator instance
     * @throws Error if shell is not supported
     */
    static createGenerator(shell) {
        switch (shell) {
            case 'zsh':
                return new ZshGenerator();
            case 'bash':
                return new BashGenerator();
            case 'fish':
                return new FishGenerator();
            case 'powershell':
                return new PowerShellGenerator();
            default:
                throw new Error(`Unsupported shell: ${shell}`);
        }
    }
    /**
     * Create a completion installer for the specified shell
     *
     * @param shell - The target shell
     * @returns CompletionInstaller instance
     * @throws Error if shell is not supported
     */
    static createInstaller(shell) {
        switch (shell) {
            case 'zsh':
                return new ZshInstaller();
            case 'bash':
                return new BashInstaller();
            case 'fish':
                return new FishInstaller();
            case 'powershell':
                return new PowerShellInstaller();
            default:
                throw new Error(`Unsupported shell: ${shell}`);
        }
    }
    /**
     * Check if a shell is supported
     *
     * @param shell - The shell to check
     * @returns true if the shell is supported
     */
    static isSupported(shell) {
        return this.SUPPORTED_SHELLS.includes(shell);
    }
    /**
     * Get list of all supported shells
     *
     * @returns Array of supported shell names
     */
    static getSupportedShells() {
        return [...this.SUPPORTED_SHELLS];
    }
}
//# sourceMappingURL=factory.js.map