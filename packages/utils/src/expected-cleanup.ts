// The well-known marker survives duplicate modules and realms without loading
// cleanup handlers, logging, or the native addon into lightweight reporters.
export const EXPECTED_CLEANUP = Symbol.for("omp.expectedCleanupError");

export function hasExpectedCleanupMarker(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if (Reflect.get(current, EXPECTED_CLEANUP) === true) return true;
		current = Reflect.get(current, "cause");
	}
	return false;
}
