/**
 * Telemetry opt-out signals, shared by telemetry and the version check so both
 * outbound surfaces honor exactly the same values.
 *
 * Parsing is tolerant in the style of isCiEnvironment(): a user who wrote
 * DO_NOT_TRACK=true meant it, and an exact-match test that silently kept
 * sending would be a privacy control that does not work. Ambiguity fails
 * safe — a value we cannot read as "on" suppresses the request rather than
 * enabling it.
 */
/** True when `DO_NOT_TRACK` is set to anything but an explicit off-value. */
export declare function isDoNotTrackSet(env?: NodeJS.ProcessEnv): boolean;
/** True when `OPENSPEC_TELEMETRY` is set to anything but an explicit on-value. */
export declare function isTelemetryDisabledByEnv(env?: NodeJS.ProcessEnv): boolean;
/** True when either opt-out signal asks us to stay off the network. */
export declare function isTelemetryOptedOutByEnv(env?: NodeJS.ProcessEnv): boolean;
//# sourceMappingURL=opt-out.d.ts.map