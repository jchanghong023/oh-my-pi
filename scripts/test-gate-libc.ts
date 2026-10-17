import { dlopen } from "bun:ffi";
import type { FFIFunction } from "bun:ffi";

/** Resolve both glibc and musl without assuming the host's libc soname. */
export function openGateLibc<Symbols extends Record<string, FFIFunction>>(symbols: Symbols) {
	const names = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
	let lastError: unknown;
	for (const name of names) {
		try {
			return dlopen(name, symbols);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error("Cannot load gate libc", { cause: lastError });
}
