//! Directory-relative worktree mutations for the owned patch API only.

use std::{
	ffi::OsStr,
	fs::File,
	io,
	path::{Component, Components, Path},
	sync::atomic::{AtomicU64, Ordering},
};

use gix::index::entry::Mode;

use crate::error::{Error, Result};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(super) use windows::{path_identity, protected_ids};
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

type Identity = (u64, u64);
pub(super) type EntryKey = (Identity, std::path::PathBuf);

#[derive(PartialEq, Eq)]
pub(super) struct Observation {
	pub(super) version: String,
	pub(super) mode:    Mode,
	id:                 Identity,
}

pub(super) struct OwnedRoot {
	file: File,
	#[cfg(windows)]
	protected: Vec<Identity>,
}

impl OwnedRoot {
	pub(super) fn open(repo: &super::GitRepo) -> Result<Self> {
		// The checkout root may itself be reached through a symlink.
		Ok(Self {
			file: platform::open_root(&std::fs::canonicalize(repo.root())?)?,
			#[cfg(windows)]
			protected: protected_ids(repo)?,
		})
	}

	fn open_child(&self, parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
		let dir = platform::open_child(parent, name, create)?;
		#[cfg(windows)]
		if self.protected.contains(&platform::identity(&dir)?) {
			return Err(io::Error::new(io::ErrorKind::PermissionDenied, "patch cannot write Git metadata"));
		}
		Ok(dir)
	}
}

/// The nearest existing directory, pinned through both the final preimage
/// observation and the write. Missing components are created relative to it
/// only after the caller has confirmed that the destination should be absent.
pub(super) struct PinnedPath<'a> {
	root:    &'a OwnedRoot,
	parent:  Option<File>,
	missing: Components<'a>,
	leaf:    &'a OsStr,
}

impl<'a> PinnedPath<'a> {
	pub(super) fn open(root: &'a OwnedRoot, path: &'a Path) -> Result<Self> {
		let mut missing = path.components();
		let Some(Component::Normal(leaf)) = missing.next_back() else {
			return Err(Error::backend("git owned patch", "noncanonical patch path"));
		};
		let mut parent = None;
		loop {
			let mut remaining = missing.clone();
			let Some(component) = remaining.next() else {
				break;
			};
			let name = normal_name(component)?;
			match root.open_child(parent.as_ref().unwrap_or(&root.file), name, false) {
				Ok(dir) => {
					parent = Some(dir);
					missing = remaining;
				},
				Err(err) if err.kind() == io::ErrorKind::NotFound => break,
				Err(err) => {
					return Err(Error::backend(
						"git owned patch",
						format!("unsafe parent of {}: {err}", path.display()),
					));
				},
			}
		}
		Ok(Self { root, parent, missing, leaf })
	}

	pub(super) fn observe(&self) -> Result<Option<Observation>> {
		if self.missing.as_path().as_os_str().is_empty() {
			let observed = platform::observe(self.parent(), self.leaf)?;
			#[cfg(windows)]
			if observed.as_ref().is_some_and(|entry| self.root.protected.contains(&entry.id)) {
				return Err(Error::backend("git owned patch", "patch cannot write Git metadata"));
			}
			Ok(observed)
		} else {
			Ok(None)
		}
	}

	pub(super) fn replace(
		&mut self,
		bytes: &[u8],
		mode: Mode,
		before: Option<&Observation>,
	) -> Result<()> {
		for component in self.missing.by_ref() {
			let name = normal_name(component)?;
			let parent = self.parent.as_ref().unwrap_or(&self.root.file);
			self.parent = Some(self.root.open_child(parent, name, true)?);
		}
		platform::replace(self.parent(), self.leaf, bytes, mode, before)
	}

	pub(super) fn remove(&self, before: &Observation) -> Result<()> {
		platform::remove(self.parent(), self.leaf, before)
	}

	pub(super) fn entry_key(&self) -> io::Result<EntryKey> {
		platform::entry_key(
			self.parent(),
			self.missing.as_path(),
			self.leaf,
			#[cfg(windows)]
			&self.root.protected,
		)
	}

	fn parent(&self) -> &File {
		self.parent.as_ref().unwrap_or(&self.root.file)
	}
}

fn normal_name(component: Component<'_>) -> Result<&OsStr> {
	match component {
		Component::Normal(name) => Ok(name),
		_ => Err(Error::backend("git owned patch", "noncanonical patch path")),
	}
}

pub(super) fn mode_matches(actual: Option<Mode>, exists: bool, expected: Option<Mode>) -> bool {
	let Some(actual) = actual else {
		return !exists;
	};
	exists
		&& match expected {
			None => true,
			Some(Mode::COMMIT) => false,
			Some(Mode::SYMLINK) => cfg!(windows) || actual == Mode::SYMLINK,
			Some(mode) => {
				actual != Mode::SYMLINK
					&& (cfg!(windows)
						|| (actual == Mode::FILE_EXECUTABLE) == (mode == Mode::FILE_EXECUTABLE))
			},
		}
}

fn changed(name: &OsStr) -> Error {
	Error::backend(
		"git owned patch",
		format!("preimage changed before publication: {}", name.display()),
	)
}

fn recovery_error(name: &OsStr, saved: &OsStr, err: Error, restore: io::Error) -> Error {
	Error::backend(
		"git owned patch",
		format!(
			"{}: {err}; displaced entry retained as {} ({restore})",
			name.display(),
			saved.display(),
		),
	)
}

fn staging_names(leaf: &OsStr) -> impl Iterator<Item = String> {
	static NEXT: AtomicU64 = AtomicU64::new(0);
	let pid = std::process::id();
	(0..128)
		.map(move |_| format!(".omp-owned-{pid:x}-{:x}", NEXT.fetch_add(1, Ordering::Relaxed)))
		.filter(move |name| {
			!leaf
				.as_encoded_bytes()
				.eq_ignore_ascii_case(name.as_bytes())
		})
}

#[cfg(unix)]
mod unix {
	use std::{
		ffi::OsStr,
		fs::File,
		io::{self, Write},
		os::unix::ffi::OsStrExt,
		path::Path,
	};

	use gix::index::entry::Mode;
	use rustix::fs::{self, AtFlags, FileType, Mode as Permissions, OFlags};

	use super::{EntryKey, Identity, Observation, changed, staging_names};
	#[cfg(any(
		target_os = "android",
		target_os = "linux",
		target_vendor = "apple",
		target_os = "redox"
	))]
	use super::recovery_error;
	use crate::{
		error::{Error, Result},
		git::mutate::{raw_sha256, sha256_reader},
	};

	fn directory_flags() -> OFlags {
		#[cfg(any(target_os = "android", target_os = "linux"))]
		let access = OFlags::PATH;
		#[cfg(target_vendor = "apple")]
		let access = OFlags::from_bits_retain(libc::O_SEARCH as _);
		#[cfg(not(any(target_os = "android", target_os = "linux", target_vendor = "apple")))]
		let access = OFlags::RDONLY;
		access | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
	}

	pub(in super::super) fn open_root(path: &Path) -> io::Result<File> {
		Ok(fs::open(path, directory_flags(), Permissions::empty()).map(File::from)?)
	}

	pub(super) fn open_child(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
		if create {
			match fs::mkdirat(parent, name, Permissions::from_raw_mode(0o777)) {
				Ok(()) | Err(rustix::io::Errno::EXIST) => {},
				Err(err) => return Err(err.into()),
			}
		}
		Ok(fs::openat(parent, name, directory_flags(), Permissions::empty()).map(File::from)?)
	}

	fn identity(stat: &fs::Stat) -> Identity {
		(stat.st_dev as u64, stat.st_ino as u64)
	}

	pub(super) fn entry_key(parent: &File, missing: &Path, leaf: &OsStr) -> io::Result<EntryKey> {
		let id = identity(&fs::fstat(parent)?);
		#[cfg(any(target_os = "android", target_os = "linux"))]
		if missing.as_os_str().is_empty() {
			use std::os::fd::AsRawFd;

			if let Ok(entry) = fs::openat(parent, leaf, OFlags::PATH | OFlags::NOFOLLOW, Permissions::empty())
				&& let Ok(path) = std::fs::read_link(format!("/proc/self/fd/{}", entry.as_raw_fd()))
				&& let Some(name) = path.file_name()
			{
				return Ok((id, name.into()));
			}
		}
		#[cfg(target_vendor = "apple")]
		if let Some(key) = apple_entry_name(parent, missing, leaf)? {
			return Ok((id, key));
		}
		Ok((id, missing.join(leaf)))
	}

	#[cfg(target_vendor = "apple")]
	fn apple_entry_name(
		parent: &File,
		missing: &Path,
		leaf: &OsStr,
	) -> io::Result<Option<std::path::PathBuf>> {
		use std::{ffi::CString, mem::size_of_val, os::fd::AsRawFd};

		// SAFETY: The directory handle is live and pathconf takes no pointer.
		let insensitive = unsafe { libc::fpathconf(parent.as_raw_fd(), libc::_PC_CASE_SENSITIVE) } == 0;

		if missing.as_os_str().is_empty() {
			let name = CString::new(leaf.as_bytes()).map_err(|_| io::ErrorKind::InvalidInput)?;
			// SAFETY: All fields of an empty attrlist are integers.
			let mut attrs: libc::attrlist = unsafe { std::mem::zeroed() };
			attrs.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
			attrs.commonattr = libc::ATTR_CMN_NAME;
			let mut data = [0_u32; 256];
			// SAFETY: The fd, NUL-terminated pathname and full-size buffers are live.
			let result = unsafe {
				libc::getattrlistat(
					parent.as_raw_fd(),
					name.as_ptr(),
					(&raw mut attrs).cast(),
					data.as_mut_ptr().cast(),
					size_of_val(&data),
					libc::FSOPT_NOFOLLOW.into(),
				)
			};
			if result == 0 {
				// The 32-bit length is followed by the attribute reference, whose
				// signed offset is relative to the start of that reference.
				let offset = usize::try_from(data[1]).map_err(|_| io::ErrorKind::InvalidData)?;
				// SAFETY: The initialized u32 buffer is live for the returned view.
				let bytes = unsafe {
					std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), size_of_val(&data))
				};
				let start = size_of::<u32>() + offset;
				let entry = bytes
					.get(start..start + data[2] as usize)
					.and_then(|bytes| bytes.strip_suffix(&[0]))
					.ok_or(io::ErrorKind::InvalidData)?;
				let entry = OsStr::from_bytes(entry);
				return Ok(Some(if insensitive {
					entry.to_string_lossy().to_lowercase().into()
				} else {
					entry.into()
				}));
			}
			let err = io::Error::last_os_error();
			if !matches!(
				err.kind(),
				io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
			) {
				return Err(err);
			}
		}
		Ok(insensitive.then(|| missing.join(leaf).to_string_lossy().to_lowercase().into()))
	}

	pub(super) fn observe(parent: &File, name: &OsStr) -> Result<Option<Observation>> {
		let stat = match fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
			Ok(stat) => stat,
			Err(rustix::io::Errno::NOENT) => return Ok(None),
			Err(err) => return Err(io::Error::from(err).into()),
		};
		let id = identity(&stat);
		let (version, mode) = match FileType::from_raw_mode(stat.st_mode) {
			FileType::Symlink => {
				let target = fs::readlinkat(parent, name, Vec::new()).map_err(io::Error::from)?;
				(raw_sha256(target.as_bytes())?, Mode::SYMLINK)
			},
			FileType::RegularFile => {
				let fd = fs::openat(
					parent,
					name,
					OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
					Permissions::empty(),
				)
				.map_err(io::Error::from)?;
				let file = File::from(fd);
				let opened = fs::fstat(&file).map_err(io::Error::from)?;
				if identity(&opened) != id
					|| FileType::from_raw_mode(opened.st_mode) != FileType::RegularFile
				{
					return Err(changed(name));
				}
				let mode = if opened.st_mode & 0o111 == 0 { Mode::FILE } else { Mode::FILE_EXECUTABLE };
				(sha256_reader(file)?, mode)
			},
			_ => return Err(not_file(name)),
		};
		let current = fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
		if identity(&current) != id
			|| current.st_mode != stat.st_mode
			|| current.st_ctime != stat.st_ctime
			|| current.st_ctime_nsec != stat.st_ctime_nsec
			|| current.st_mtime != stat.st_mtime
			|| current.st_mtime_nsec != stat.st_mtime_nsec
			|| current.st_size != stat.st_size
		{
			return Err(changed(name));
		}
		Ok(Some(Observation { version, mode, id }))
	}

	fn not_file(name: &OsStr) -> Error {
		Error::backend(
			"git owned patch",
			format!("not a regular file or symlink: {}", name.display()),
		)
	}

	pub(super) fn replace(
		parent: &File,
		name: &OsStr,
		bytes: &[u8],
		mode: Mode,
		before: Option<&Observation>,
	) -> Result<()> {
		for staged in staging_names(name) {
			let mut file = if mode == Mode::SYMLINK {
				match fs::symlinkat(OsStr::from_bytes(bytes), parent, staged.as_str()) {
					Ok(()) => None,
					Err(rustix::io::Errno::EXIST) => continue,
					Err(err) => return Err(io::Error::from(err).into()),
				}
			} else {
				match fs::openat(
					parent,
					staged.as_str(),
					OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::CLOEXEC,
					Permissions::RUSR | Permissions::WUSR,
				) {
					Ok(fd) => Some(File::from(fd)),
					Err(rustix::io::Errno::EXIST) => continue,
					Err(err) => return Err(io::Error::from(err).into()),
				}
			};
			let mut moved = false;
			let result = (|| -> Result<()> {
				if let Some(file) = file.as_mut() {
					file.write_all(bytes)?;
					let permissions = if mode == Mode::FILE_EXECUTABLE {
						0o755
					} else {
						0o644
					};
					fs::fchmod(file, Permissions::from_raw_mode(permissions)).map_err(io::Error::from)?;
				}
				let staged_id = identity(&match file.as_ref() {
					Some(file) => fs::fstat(file),
					None => fs::statat(parent, staged.as_str(), AtFlags::SYMLINK_NOFOLLOW),
				}.map_err(io::Error::from)?);
				#[allow(unused_mut, reason = "exclusive rename is platform-specific")]
				let mut publish = || -> Result<()> {
					let current = fs::statat(parent, staged.as_str(), AtFlags::SYMLINK_NOFOLLOW)
						.map_err(io::Error::from)?;
					if identity(&current) != staged_id {
						return Err(changed(OsStr::new(&staged)));
					}
					#[cfg(any(
						target_os = "android",
						target_os = "linux",
						target_vendor = "apple",
						target_os = "redox"
					))]
					match fs::renameat_with(parent, staged.as_str(), parent, name, fs::RenameFlags::NOREPLACE) {
						Ok(()) => {
							moved = true;
							return Ok(());
						},
						Err(
							rustix::io::Errno::NOSYS
							| rustix::io::Errno::INVAL
							| rustix::io::Errno::OPNOTSUPP,
						) => {},
						Err(err) => return Err(io::Error::from(err).into()),
					}
					// A hard link is likewise exclusive, and without
					// SYMLINK_FOLLOW it publishes the staged symlink itself.
					fs::linkat(parent, staged.as_str(), parent, name, AtFlags::empty())
						.map_err(io::Error::from)?;
					Ok(())
				};
				if let Some(before) = before {
					checked_mutation(parent, name, before, publish)
				} else {
					publish()
				}
			})();
			if moved {
				return result;
			}
			let cleanup = fs::unlinkat(parent, staged.as_str(), AtFlags::empty());
			return result.and_then(|()| match cleanup {
				Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
				Err(err) => Err(io::Error::from(err).into()),
			});
		}
		Err(io::Error::from(io::ErrorKind::AlreadyExists).into())
	}

	pub(super) fn remove(parent: &File, name: &OsStr, before: &Observation) -> Result<()> {
		checked_mutation(parent, name, before, || Ok(()))
	}

	#[cfg(any(
		target_os = "android",
		target_os = "linux",
		target_vendor = "apple",
		target_os = "redox"
	))]
	fn checked_mutation(
		parent: &File,
		name: &OsStr,
		before: &Observation,
		publish: impl FnOnce() -> Result<()>,
	) -> Result<()> {
		use fs::RenameFlags;

		for saved in staging_names(name) {
			let current = fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW).map_err(io::Error::from)?;
			if identity(&current) != before.id {
				return Err(changed(name));
			}
			let saved = OsStr::new(&saved);
			// Neither parking nor restoring an old entry may overwrite another
			// writer. Check the displaced entry itself to catch a racing save.
			match fs::renameat_with(parent, name, parent, saved, RenameFlags::NOREPLACE) {
				Ok(()) => {},
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
				Err(err) => return Err(err.into()),
			}
			let result = (|| {
				if observe(parent, saved)?.as_ref() != Some(before) {
					return Err(changed(name));
				}
				publish()
			})();
			if let Err(err) = result {
				return Err(match fs::renameat_with(parent, saved, parent, name, RenameFlags::NOREPLACE) {
					Ok(()) => err,
					Err(restore) => recovery_error(name, saved, err, restore),
				});
			}
			// Unix cannot exclude writers still holding an fd to this inode.
			// Preserve detectable late edits instead of discarding the backup.
			let retained = |err| {
				recovery_error(name, saved, err, io::Error::other("publication already performed"))
			};
			match observe(parent, saved) {
				Ok(observed) if observed.as_ref() == Some(before) => {},
				Ok(_) => return Err(retained(changed(name))),
				Err(err) => return Err(retained(err)),
			}
			return fs::unlinkat(parent, saved, AtFlags::empty())
				.map_err(|err| retained(io::Error::from(err).into()));
		}
		Err(io::Error::from(io::ErrorKind::AlreadyExists).into())
	}

	#[cfg(not(any(
		target_os = "android",
		target_os = "linux",
		target_vendor = "apple",
		target_os = "redox"
	)))]
	fn checked_mutation(
		_parent: &File,
		_name: &OsStr,
		_before: &Observation,
		_publish: impl FnOnce() -> Result<()>,
	) -> Result<()> {
		Err(io::Error::new(io::ErrorKind::Unsupported, "checked replacement needs exclusive rename").into())
	}
}
