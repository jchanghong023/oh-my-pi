//! Cross-process advisory locks backed by platform ownership primitives.
//!
//! Windows uses named mutexes, so it leaves no filesystem artifact. Unix
//! platforms lock a persistent sidecar: Linux takes an open-file-description
//! record lock, other Unix platforms `flock(2)`. Linux also respects the
//! abstract-socket name held by an older build.

use std::{
	io,
	path::{Path, PathBuf},
};

#[cfg(target_os = "linux")]
mod legacy_abstract;
#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(unix)]
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

#[cfg(target_os = "linux")]
fn effective_user_id() -> libc::uid_t {
	// SAFETY: geteuid has no preconditions.
	unsafe { libc::geteuid() }
}

#[cfg(target_os = "linux")]
fn keyed_root() -> PathBuf {
	format!("/dev/shm/omp-file-locks-{}", effective_user_id()).into()
}

#[cfg(target_os = "linux")]
fn keyed_parts(path: &str) -> Option<(&Path, &str)> {
	let path = Path::new(path);
	let parent = path.parent()?;
	if parent.parent() != Some(Path::new("/dev/shm")) || parent != keyed_root().as_path() {
		return None;
	}
	// Old builds used the filename alone as the abstract address.
	Some((parent, path.file_name()?.to_str()?))
}

#[cfg(target_os = "linux")]
fn prepare_keyed_root(root: &Path) -> io::Result<()> {
	use std::{
		fs,
		os::unix::fs::{DirBuilderExt, MetadataExt},
	};

	let metadata = fs::symlink_metadata(root).or_else(|error| {
		if error.kind() != io::ErrorKind::NotFound {
			return Err(error);
		}
		match fs::DirBuilder::new().mode(0o700).create(root) {
			Ok(()) => {},
			Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error),
		}
		fs::symlink_metadata(root)
	})?;
	if !metadata.is_dir() || metadata.uid() != effective_user_id() || metadata.mode() & 0o077 != 0 {
		return Err(io::Error::new(
			io::ErrorKind::PermissionDenied,
			format!("file lock directory is not private to this user: {}", root.display()),
		));
	}
	Ok(())
}

/// Process-owned cross-platform advisory lock, released on drop or process
/// exit.
pub struct FileLock {
	inner: Option<platform::PlatformFileLock>,
}

impl FileLock {
	/// Resolves a filename key shared across working directories. The key must
	/// be a single filename, not a path.
	pub fn keyed_path(key: &str) -> PathBuf {
		#[cfg(target_os = "linux")]
		{
			keyed_root().join(key)
		}
		#[cfg(all(unix, not(target_os = "linux")))]
		{
			Path::new("/tmp").join(key)
		}
		#[cfg(windows)]
		{
			PathBuf::from(key)
		}
	}

	/// Tries to acquire a lock without blocking.
	///
	/// # Errors
	/// Returns an error if the path is not UTF-8 or the platform operation
	/// fails.
	pub fn try_acquire_path(path: &Path) -> io::Result<Self> {
		let path = path.to_str().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path is not valid UTF-8")
		})?;
		#[cfg(target_os = "linux")]
		let key = match keyed_parts(path) {
			Some((root, key)) => {
				prepare_keyed_root(root)?;
				key
			},
			None => path,
		};
		let inner = platform::try_acquire(path)?;
		#[cfg(target_os = "linux")]
		let inner = if inner.is_some() && legacy_abstract::is_bound(key)? {
			None
		} else {
			inner
		};
		Ok(Self { inner })
	}

	/// Observes ownership without acquiring the lock.
	///
	/// # Errors
	/// Returns an error if the path is not UTF-8 or the platform probe fails.
	pub fn is_held_path(path: &Path) -> io::Result<bool> {
		let path = path.to_str().ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "lock path is not valid UTF-8")
		})?;
		let held = platform::is_held(path)?;
		#[cfg(target_os = "linux")]
		let held = held || legacy_abstract::is_bound(keyed_parts(path).map_or(path, |(_, key)| key))?;
		Ok(held)
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

	#[cfg(target_os = "linux")]
	#[test]
	fn lock_held_by_an_older_build_is_respected() {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		let key = format!("omp-file-lock-legacy-{}-{nonce}", std::process::id());
		let path = std::env::temp_dir().join(&key);
		assert_older_build_lock(&path, path.to_str().expect("utf-8 temp path"));
		assert_older_build_lock(&FileLock::keyed_path(&key), &key);
	}

	#[cfg(target_os = "linux")]
	fn assert_older_build_lock(path: &std::path::Path, key: &str) {
		use std::os::{
			linux::net::SocketAddrExt,
			unix::net::{SocketAddr, UnixDatagram},
		};

		let name = super::memory_lock_name(key);
		let address = SocketAddr::from_abstract_name(name.as_bytes()).expect("abstract name");
		let older_build = UnixDatagram::bind_addr(&address).expect("bind the older build's name");

		let refused = FileLock::try_acquire_path(path).expect("acquire attempt");
		assert!(!refused.is_acquired());
		assert!(FileLock::is_held_path(path).expect("probe while the older build holds it"));

		drop(older_build);
		assert!(!FileLock::is_held_path(path).expect("probe after the older build exits"));
		let mut lock = FileLock::try_acquire_path(path).expect("acquire");
		assert!(lock.is_acquired());
		lock.release_native().expect("release");
		let _ = std::fs::remove_file(path);
	}
}
