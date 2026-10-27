/**
 * EasyCode Command Adapter
 *
 * Formats commands for OrionStarAI/EasyCode using its TOML command format.
 * https://github.com/OrionStarAI/EasyCode
 */
import type { ToolCommandAdapter } from '../types.js';
/**
 * EasyCode adapter for command generation.
 * File path: .easycode/commands/opsx/<id>.toml
 *
 * Format:
 *   description = "<basic-string>"         single-line, backslash/quote-safe
 *   prompt = """<multiline-string>"""       multiline, backslash/triple-quote-safe
 */
export declare const easycodeAdapter: ToolCommandAdapter;
//# sourceMappingURL=easycode.d.ts.map