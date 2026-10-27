/**
 * CI environment detection shared by telemetry and the version check.
 *
 * Providers set CI to "true", "1", "yes", etc. Only an explicit off-value
 * counts as "not CI", so an unknown value still suppresses outbound requests
 * rather than surprising a build.
 */
/**
 * True when `CI` is set to anything other than an explicit off-value.
 */
export declare function isCiEnvironment(env?: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=ci.d.ts.map