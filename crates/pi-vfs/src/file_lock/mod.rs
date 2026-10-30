//! Cross-process advisory locks backed by platform ownership primitives.
//!
//! Linux uses abstract Unix sockets and Windows uses named mutexes, so neither
//! platform leaves a filesystem artifact. Other Unix platforms use `flock(2)`
//! on a persistent sidecar because they lack a process-owned in-memory name
//! registry with automatic crash recovery.

use std::{io, path::Path};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(all(unix, not(target_os = "linux")))]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(all(unix, not(target_os = "linux")))]
use unix as platform;
#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn memory_lock_name(path: &str) -> String {
	const HIGH_SEED: u64 = 0x4f4d_502d_4c4f_434b;
	const LOW_SEED: u64 = 0x5049_2d46_494c_454c;
	let bytes = path.as_bytes();
	let high = xxhash_rust::xxh64::xxh64(bytes, HIGH_SEED);
	let low = xxhash_rust::xxh64::xxh64(bytes, LOW_SEED);
	format!("omp-file-lock-{high:016x}{low:016x}")
}

/// Process-owned cross-platform advisory lock, released on drop or process
/// exit.
pub struct FileLock {
	inner: Option<platform::PlatformFileLock>,
}

impl FileLock {
	/// Tries to acquire a lock without blocking.
	///
	/// # Errors
	/// Returns an error if the path is not UTF-8 or the platform operation
	/// fails.
	pub fn try_acquire_path(path: &Path) -> io::Result<Self> {
		let path = path.to_str().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path is not valid UTF-8")
		})?;
		platform::try_acquire(path).map(|inner| Self { inner })
	}

	/// Observes ownership without acquiring the lock.
	///
	/// # Errors
	/// Returns an error if the path is not UTF-8 or the platform probe fails.
	pub fn is_held_path(path: &Path) -> io::Result<bool> {
		let path = path.to_str().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path is not valid UTF-8")
		})?;
		platform::is_held(path)
	}

	/// Whether this handle owns the requested lock.
	pub const fn is_acquired(&self) -> bool {
		self.inner.is_some()
	}

	/// Releases ownership while preserving the handle on failure; idempotent.
	///
	/// # Errors
	/// Returns the platform error if releasing ownership fails.
	pub fn release_native(&mut self) -> io::Result<()> {
		let Some(mut inner) = self.inner.take() else {
			return Ok(());
		};
		if let Err(error) = inner.release() {
			self.inner = Some(inner);
			return Err(error);
		}
		Ok(())
	}
}

impl Drop for FileLock {
	fn drop(&mut self) {
		if let Some(inner) = self.inner.as_mut() {
			let _ = inner.release();
		}
	}
}

// Android has no probe (`unix::is_held` reports Unsupported).
#[cfg(all(test, not(target_os = "android")))]
mod tests {
	use std::time::{SystemTime, UNIX_EPOCH};

	use super::FileLock;

	#[test]
	fn probe_sees_holder_without_taking_the_lock() {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		let path =
			std::env::temp_dir().join(format!("omp-file-lock-probe-{}-{nonce}", std::process::id()));
		assert!(!FileLock::is_held_path(&path).expect("probe unlocked path"));
		let mut lease = FileLock::try_acquire_path(&path).expect("acquire");
		assert!(lease.is_acquired(), "free lease");
		assert!(FileLock::is_held_path(&path).expect("probe held path"));
		lease.release_native().expect("release");
		assert!(!FileLock::is_held_path(&path).expect("probe released path"));
		// A probe never leaves the path held for the next acquirer.
		let mut successor = FileLock::try_acquire_path(&path).expect("reacquire");
		assert!(successor.is_acquired(), "probe left the lease free");
		successor.release_native().expect("release successor");
		let _ = std::fs::remove_file(path);
	}
}
