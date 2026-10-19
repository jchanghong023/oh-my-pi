//! Stable POSIX record locks for explicitly requested persistent configuration
//! I/O. Every filesystem operation, including descriptor destruction, runs off
//! the JS thread.

use std::sync::{Arc, Mutex};

use napi_derive::napi;

use crate::task::{self, Promise};

/// A stable-sidecar POSIX lock, separate from the local-only `FileLock`
/// protocol.
#[napi]
pub struct PersistentFileLock {
	owner:    Arc<Mutex<Option<u64>>>,
	acquired: bool,
}

/// Open and try `F_SETLK` on a native blocking worker. Unsupported platforms
/// fail explicitly.
#[napi]
pub fn try_acquire_persistent_file_lock(path: String) -> Promise<PersistentFileLock> {
	task::blocking("persistent_file_lock_acquire", (), move |_| {
		let owner = platform::acquire(&path).map_err(lock_error)?;
		Ok(PersistentFileLock { acquired: owner.is_some(), owner: Arc::new(Mutex::new(owner)) })
	})
}

#[napi]
impl PersistentFileLock {
	/// Whether this attempt acquired ownership (false means contention).
	#[napi(getter)]
	pub const fn acquired(&self) -> bool {
		self.acquired
	}

	/// Release on a native blocking worker; repeated calls are safe.
	#[napi]
	pub fn release(&self) -> Promise<()> {
		let owner = Arc::clone(&self.owner);
		task::blocking("persistent_file_lock_release", (), move |_| release_owner(&owner))
	}
}

fn lock_error(error: std::io::Error) -> napi::Error {
	napi::Error::from_reason(format!("Persistent POSIX file lock: {error}"))
}

fn release_owner(owner: &Mutex<Option<u64>>) -> napi::Result<()> {
	let mut owner = owner
		.lock()
		.map_err(|_| napi::Error::from_reason("Persistent lock owner poisoned"))?;
	if let Some(id) = *owner {
		platform::release(id).map_err(lock_error)?;
		*owner = None;
	}
	Ok(())
}

fn finalize_owner(owner: &Mutex<Option<u64>>) {
	// There can be an explicit release worker in flight. Serialize with it,
	// but do not leave an unreachable owner behind if either mutex poisoned.
	let mut owner = owner.lock().unwrap_or_else(|error| error.into_inner());
	if let Some(id) = owner.take() {
		platform::finalize(id);
	}
}

impl Drop for PersistentFileLock {
	fn drop(&mut self) {
		if !self.acquired || self.owner.try_lock().is_ok_and(|owner| owner.is_none()) {
			return;
		}
		// This also covers an acquired result discarded before JS receives it.
		// Never close an NFS descriptor from a JS finalizer.
		let owner = Arc::clone(&self.owner);
		drop(napi::bindgen_prelude::spawn_blocking(move || {
			finalize_owner(&owner);
		}));
	}
}

#[cfg(not(unix))]
mod platform {
	use std::io;

	pub fn acquire(_path: &str) -> io::Result<Option<u64>> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"persistent POSIX record locks are unsupported on this platform",
		))
	}

	pub fn release(_id: u64) -> io::Result<()> {
		Err(io::Error::new(
			io::ErrorKind::Unsupported,
			"persistent POSIX record locks are unsupported on this platform",
		))
	}

	pub const fn finalize(_id: u64) {}
}

#[cfg(unix)]
mod platform {
	use std::{
		collections::HashMap,
		fs::{self, File, OpenOptions},
		io,
		os::{
			fd::AsRawFd,
			unix::fs::{MetadataExt, OpenOptionsExt},
		},
		path::Path,
		sync::{LazyLock, Mutex},
	};

	type Identity = (u64, u64);

	struct Entry {
		id:      u64,
		file:    File,
		// POSIX closes of ANY descriptor for an inode release the process's lock.
		// A raced alias must therefore stay open until this owner is released.
		aliases: Vec<File>,
	}

	#[derive(Default)]
	struct Registry {
		entries:      HashMap<Identity, Entry>,
		next_id:      u64,
		unclassified: Vec<File>,
	}

	static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

	fn invalid(message: &'static str) -> io::Error {
		io::Error::new(io::ErrorKind::PermissionDenied, message)
	}

	fn validate(metadata: &fs::Metadata) -> io::Result<()> {
		// SAFETY: geteuid has no arguments or memory preconditions.
		let uid = unsafe { libc::geteuid() };
		if !metadata.is_file()
			|| metadata.uid() != uid
			|| metadata.mode() & 0o7777 != 0o600
			|| metadata.nlink() != 1
		{
			return Err(invalid(
				"sidecar must be a regular, single-link, current-user-owned 0600 file",
			));
		}
		Ok(())
	}

	fn identity(metadata: &fs::Metadata) -> Identity {
		(metadata.dev(), metadata.ino())
	}

	fn set_lock(file: &File, kind: libc::c_short) -> io::Result<()> {
		// SAFETY: zero is valid for flock's integer fields; all lock range fields
		// are explicitly set for a whole-file, nonblocking POSIX record lock.
		let mut lock: libc::flock = unsafe { std::mem::zeroed() };
		lock.l_type = kind;
		lock.l_whence = libc::SEEK_SET as libc::c_short;
		lock.l_start = 0;
		lock.l_len = 0;
		// SAFETY: file owns a live fd and lock points to a valid flock.
		if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &lock) } == -1 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	}

	pub fn acquire(path: &str) -> io::Result<Option<u64>> {
		// Held through open/stat/fcntl/close: no other worker may open then close
		// an owned inode, or exploit process-scoped F_SETLK reentrancy.
		let mut registry = REGISTRY
			.lock()
			.map_err(|_| io::Error::other("persistent lock registry poisoned"))?;
		let path = Path::new(path);
		match fs::symlink_metadata(path) {
			Ok(metadata) => {
				validate(&metadata)?;
				if registry.entries.contains_key(&identity(&metadata)) {
					return Ok(None);
				}
			},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error),
		}
		let file = OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.mode(0o600)
			.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
			.open(path)?;
		let metadata = match file.metadata() {
			Ok(metadata) => metadata,
			Err(error) => {
				// The inode is unknown: closing could unlock an existing owner.
				// Keep it until all known owners have released, then close safely.
				if !registry.entries.is_empty() {
					registry.unclassified.push(file);
				}
				return Err(error);
			},
		};
		let key = identity(&metadata);
		if let Some(entry) = registry.entries.get_mut(&key) {
			entry.aliases.push(file);
			return Ok(None);
		}
		validate(&metadata)?;
		// Verify the opened inode is still the named sidecar; never unlink or
		// replace it. Uncooperative external replacement is outside the protocol.
		let named = fs::symlink_metadata(path)?;
		validate(&named)?;
		if identity(&named) != key {
			return Err(invalid("sidecar changed while opening"));
		}
		match set_lock(&file, libc::F_WRLCK as libc::c_short) {
			Ok(()) => {},
			Err(error) if matches!(error.raw_os_error(), Some(libc::EACCES) | Some(libc::EAGAIN)) => {
				return Ok(None);
			},
			Err(error) => return Err(error),
		}
		registry.next_id = registry
			.next_id
			.checked_add(1)
			.ok_or_else(|| io::Error::other("persistent lock owner IDs exhausted"))?;
		let id = registry.next_id;
		registry
			.entries
			.insert(key, Entry { id, file, aliases: Vec::new() });
		Ok(Some(id))
	}

	pub fn release(id: u64) -> io::Result<()> {
		let mut registry = REGISTRY
			.lock()
			.map_err(|_| io::Error::other("persistent lock registry poisoned"))?;
		registry.release_with(id, false, |file| set_lock(file, libc::F_UNLCK as libc::c_short))
	}

	pub fn finalize(id: u64) {
		let mut registry = REGISTRY.lock().unwrap_or_else(|error| error.into_inner());
		let _ =
			registry.release_with(id, true, |file| set_lock(file, libc::F_UNLCK as libc::c_short));
	}

	impl Registry {
		fn release_with(
			&mut self,
			id: u64,
			final_release: bool,
			unlock: impl FnOnce(&File) -> io::Result<()>,
		) -> io::Result<()> {
			let key = self
				.entries
				.iter()
				.find_map(|(key, entry)| (entry.id == id).then_some(*key));
			if let Some(key) = key {
				let result = unlock(&self.entries[&key].file);
				if !final_release {
					result?;
				}
				// Explicit failures retain ownership for retry. Final destruction
				// must close even after F_UNLCK fails: no caller can retry anymore.
				// Hold the registry mutex through every close, so another local
				// owner cannot acquire this inode before its aliases are gone.
				drop(self.entries.remove(&key));
				if self.entries.is_empty() {
					// Unknown inodes may alias other owners; only the last owner's
					// destruction permits these descriptors to close safely.
					self.unclassified.clear();
				}
			}
			Ok(())
		}
	}

	#[cfg(test)]
	mod tests {
		use std::{
			io::{ErrorKind, Read},
			os::{fd::OwnedFd, unix::net::UnixStream},
		};

		use super::*;

		fn entry(id: u64) -> (Entry, UnixStream) {
			// Socket EOF observes actual descriptor destruction without depending
			// on descriptor numbers, timing, or a real NFS failure.
			let (stream, peer) = UnixStream::pair().unwrap();
			peer.set_nonblocking(true).unwrap();
			let file = File::from(OwnedFd::from(stream));
			let alias = file.try_clone().unwrap();
			(Entry { id, file, aliases: vec![alias] }, peer)
		}

		fn assert_open(peer: &mut UnixStream) {
			assert_eq!(peer.read(&mut [0]).unwrap_err().kind(), ErrorKind::WouldBlock);
		}

		fn assert_closed(peer: &mut UnixStream) {
			assert_eq!(peer.read(&mut [0]).unwrap(), 0);
		}

		#[test]
		fn explicit_unlock_failure_preserves_owner_for_retry() {
			let mut registry = Registry::default();
			let (entry, mut peer) = entry(1);
			registry.entries.insert((1, 1), entry);

			let error = registry
				.release_with(1, false, |_| Err(io::Error::from_raw_os_error(libc::EIO)))
				.unwrap_err();
			assert_eq!(error.raw_os_error(), Some(libc::EIO));
			assert!(registry.entries.contains_key(&(1, 1)));
			assert_open(&mut peer);

			registry.release_with(1, false, |_| Ok(())).unwrap();
			assert!(registry.entries.is_empty());
			assert_closed(&mut peer);
		}

		#[test]
		fn final_unlock_failure_closes_descriptors_without_closing_other_owners() {
			let mut registry = Registry::default();
			let (first, mut first_peer) = entry(1);
			let (second, mut second_peer) = entry(2);
			// An unknown descriptor could alias either owner and must remain
			// open until both owners are gone.
			registry.unclassified.push(second.file.try_clone().unwrap());
			registry.entries.insert((1, 1), first);
			registry.entries.insert((1, 2), second);

			registry
				.release_with(1, true, |_| Err(io::Error::from_raw_os_error(libc::EIO)))
				.unwrap();
			assert!(!registry.entries.contains_key(&(1, 1)));
			assert!(registry.entries.contains_key(&(1, 2)));
			assert_eq!(registry.unclassified.len(), 1);
			assert_closed(&mut first_peer);
			assert_open(&mut second_peer);

			registry
				.release_with(2, true, |_| Err(io::Error::from_raw_os_error(libc::EIO)))
				.unwrap();
			assert!(registry.entries.is_empty());
			assert!(registry.unclassified.is_empty());
			assert_closed(&mut second_peer);
		}
	}
}
