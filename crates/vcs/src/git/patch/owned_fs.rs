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
pub(super) use platform::open_root;
#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

/// The nearest existing directory, pinned through both the final preimage
/// observation and the write. Missing components are created relative to it
/// only after the caller has confirmed that the destination should be absent.
pub(super) struct PinnedPath<'a> {
	root:    &'a File,
	parent:  Option<File>,
	missing: Components<'a>,
	leaf:    &'a OsStr,
}

impl<'a> PinnedPath<'a> {
	pub(super) fn open(root: &'a File, path: &'a Path) -> Result<Self> {
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
			match platform::open_child(parent.as_ref().unwrap_or(root), name, false) {
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

	pub(super) fn observe(&self) -> Result<Option<(String, Mode)>> {
		if self.missing.as_path().as_os_str().is_empty() {
			platform::observe(self.parent(), self.leaf)
		} else {
			Ok(None)
		}
	}

	pub(super) fn replace(&mut self, bytes: &[u8], mode: Mode) -> Result<()> {
		for component in self.missing.by_ref() {
			let name = normal_name(component)?;
			let parent = self.parent.as_ref().unwrap_or(self.root);
			self.parent = Some(platform::open_child(parent, name, true)?);
		}
		platform::replace(self.parent(), self.leaf, bytes, mode)?;
		Ok(())
	}

	pub(super) fn remove(&self) -> Result<()> {
		if self.missing.as_path().as_os_str().is_empty() {
			// Only the confirmed directory entry is ours to remove.
			platform::remove(self.parent(), self.leaf)?;
		}
		Ok(())
	}

	fn parent(&self) -> &File {
		self.parent.as_ref().unwrap_or(self.root)
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

	use super::staging_names;
	use crate::{
		error::{Error, Result},
		git::mutate::{raw_sha256, sha256_reader},
	};

	fn directory_flags() -> OFlags {
		#[cfg(any(target_os = "android", target_os = "linux"))]
		let access = OFlags::PATH;
		#[cfg(not(any(target_os = "android", target_os = "linux")))]
		let access = OFlags::RDONLY;
		access | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC
	}

	pub(in super::super) fn open_root(path: &Path) -> io::Result<File> {
		Ok(fs::open(path, directory_flags(), Permissions::empty()).map(File::from)?)
	}

	pub(super) fn open_child(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
		if create {
			fs::mkdirat(parent, name, Permissions::from_raw_mode(0o777))?;
		}
		Ok(fs::openat(parent, name, directory_flags(), Permissions::empty()).map(File::from)?)
	}

	pub(super) fn observe(parent: &File, name: &OsStr) -> Result<Option<(String, Mode)>> {
		let stat = match fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW) {
			Ok(stat) => stat,
			Err(rustix::io::Errno::NOENT) => return Ok(None),
			Err(err) => return Err(io::Error::from(err).into()),
		};
		match FileType::from_raw_mode(stat.st_mode) {
			FileType::Symlink => {
				let target = fs::readlinkat(parent, name, Vec::new()).map_err(io::Error::from)?;
				Ok(Some((raw_sha256(target.as_bytes())?, Mode::SYMLINK)))
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
				let metadata = file.metadata()?;
				if metadata.is_file() {
					let mode = super::super::worktree_file_mode(&metadata, Mode::FILE);
					return Ok(Some((sha256_reader(file)?, mode)));
				}
				Err(not_file(name))
			},
			_ => Err(not_file(name)),
		}
	}

	fn not_file(name: &OsStr) -> Error {
		Error::backend(
			"git owned patch",
			format!("not a regular file or symlink: {}", name.display()),
		)
	}

	pub(super) fn replace(parent: &File, name: &OsStr, bytes: &[u8], mode: Mode) -> io::Result<()> {
		for staged in staging_names(name) {
			let mut file = if mode == Mode::SYMLINK {
				match fs::symlinkat(OsStr::from_bytes(bytes), parent, staged.as_str()) {
					Ok(()) => None,
					Err(rustix::io::Errno::EXIST) => continue,
					Err(err) => return Err(err.into()),
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
					Err(err) => return Err(err.into()),
				}
			};
			let result = (|| -> io::Result<()> {
				if let Some(file) = file.as_mut() {
					file.write_all(bytes)?;
					let permissions = if mode == Mode::FILE_EXECUTABLE {
						0o755
					} else {
						0o644
					};
					fs::fchmod(&file, Permissions::from_raw_mode(permissions))?;
				}
				fs::renameat(parent, staged.as_str(), parent, name)?;
				Ok(())
			})();
			if result.is_err() {
				let _ = fs::unlinkat(parent, staged.as_str(), AtFlags::empty());
			}
			return result;
		}
		Err(io::ErrorKind::AlreadyExists.into())
	}

	pub(super) fn remove(parent: &File, name: &OsStr) -> io::Result<()> {
		match fs::unlinkat(parent, name, AtFlags::empty()) {
			Ok(()) | Err(rustix::io::Errno::NOENT) => Ok(()),
			Err(err) => Err(err.into()),
		}
	}
}
