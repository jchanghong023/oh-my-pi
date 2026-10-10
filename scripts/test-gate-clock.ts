import { dlopen, FFIType, ptr } from "bun:ffi";

// Bun's hrtime uses a process-relative epoch on Windows. Activity emitted by
// separate compiler processes needs an OS-wide monotonic epoch, not wall time.
let readClock: (() => bigint) | undefined;
export function gateClockNanoseconds(): bigint {
	if (!readClock) {
		const sample = new BigInt64Array(2);
		if (process.platform === "win32") {
			const kernel = dlopen("kernel32.dll", {
				QueryPerformanceCounter: { args: [FFIType.ptr], returns: FFIType.i32 },
				QueryPerformanceFrequency: { args: [FFIType.ptr], returns: FFIType.i32 },
			});
			if (!kernel.symbols.QueryPerformanceFrequency(ptr(sample)) || sample[0] <= 0n) {
				kernel.close();
				throw new Error("Cannot read gate monotonic clock frequency");
			}
			const frequency = sample[0];
			readClock = () => {
				if (!kernel.symbols.QueryPerformanceCounter(ptr(sample)))
					throw new Error("Cannot read gate monotonic clock");
				return (sample[0] * 1_000_000_000n) / frequency;
			};
		} else {
			const name = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
			const libc = dlopen(name, {
				clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
			});
			const monotonic = process.platform === "darwin" ? 6 : 1;
			readClock = () => {
				if (libc.symbols.clock_gettime(monotonic, ptr(sample)) !== 0)
					throw new Error("Cannot read gate monotonic clock");
				return sample[0] * 1_000_000_000n + sample[1];
			};
		}
	}
	return readClock();
}
