/**
 * Shared TOML string escaping for command adapters.
 */
/**
 * TOML basic strings are escape-active: a backslash or double quote in the
 * value breaks the file if written raw. Newlines cannot appear in a
 * single-line basic string at all, so they are escaped too.
 */
export declare function escapeTomlBasicString(value: string): string;
/**
 * Multiline basic strings keep raw newlines and tabs, but backslashes are
 * still escape-active, any run of three quotes would end the string, and the
 * same control characters are invalid as in single-line basic strings — a
 * lone carriage return included (only LF and CRLF may appear raw; CRLF is
 * normalized away so the emitted file is single-convention). Escapes are
 * introduced after backslash-doubling so they are not re-doubled.
 */
export declare function escapeTomlMultilineBasicString(value: string): string;
//# sourceMappingURL=toml.d.ts.map