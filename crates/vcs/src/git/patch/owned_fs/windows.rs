use std::{
	ffi::{OsStr, OsString},
	fs::{File, OpenOptions},
	io::{self, Write},
	os::windows::{
		ffi::{OsStrExt, OsStringExt},
		fs::{MetadataExt, OpenOptionsExt},
		io::{AsRawHandle, FromRawHandle},
	},
	path::{Path, PathBuf},
	ptr::{null, null_mut},
};

use gix::index::entry::Mode;
use windows_sys::{
	Wdk::{
		Foundation::OBJECT_ATTRIBUTES,
		Storage::FileSystem::{
			FILE_CASE_SENSITIVE_INFORMATION, FILE_CREATE, FILE_DIRECTORY_FILE,
			FILE_DISPOSITION_DELETE, FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE,
			FILE_DISPOSITION_INFORMATION_EX, FILE_DISPOSITION_POSIX_SEMANTICS,
			FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT,
			FILE_RENAME_INFORMATION, FILE_RENAME_INFORMATION_0,
			FILE_SYNCHRONOUS_IO_NONALERT, FileCaseSensitiveInformation,
			FileDispositionInformationEx, FileRenameInformationEx, NTCREATEFILE_CREATE_DISPOSITION,
			NtCreateFile, NtQueryInformationFile, NtSetInformationFile,
		},
	},
	Win32::{
		Foundation::{HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_NORMAL,
			FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
			FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
			FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, GetFileInformationByHandle,
			GetFinalPathNameByHandleW, MAXIMUM_REPARSE_DATA_BUFFER_SIZE, SYNCHRONIZE,
			VOLUME_NAME_NT,
		},
		System::{
			IO::{DeviceIoControl, IO_STATUS_BLOCK},
			Ioctl::FSCTL_GET_REPARSE_POINT,
			SystemServices::{IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK},
		},
	},
};

use super::{EntryKey, Identity, Observation, changed, recovery_error, staging_names};
use crate::{
	error::{Error, Result},
	git::mutate::{raw_sha256, sha256_reader},
};

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const SHARE_DIRECTORY: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE;
const DIRECTORY_ACCESS: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

pub(in super::super) fn open_root(path: &Path) -> io::Result<File> {
	let file = OpenOptions::new()
		.access_mode(DIRECTORY_ACCESS)
		.share_mode(SHARE_DIRECTORY)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
		.open(path)?;
	checked_directory(file)
}

pub(super) fn open_child(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
	let disposition = if create { FILE_OPEN_IF } else { FILE_OPEN };
	checked_directory(open_relative(
		parent,
		name,
		DIRECTORY_ACCESS,
		SHARE_DIRECTORY,
		disposition,
		FILE_DIRECTORY_FILE,
	)?)
}

fn checked_directory(file: File) -> io::Result<File> {
	let metadata = file.metadata()?;
	if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return Err(io::Error::new(io::ErrorKind::NotADirectory, "not a plain directory"));
	}
	Ok(file)
}

pub(in super::super) fn path_identity(path: &Path) -> io::Result<Identity> {
	identity(
		&OpenOptions::new()
			.access_mode(FILE_READ_ATTRIBUTES)
			.share_mode(SHARE_ALL)
			.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
			.open(path)?,
	)
}

pub(in super::super) fn protected_ids(repo: &super::super::GitRepo) -> io::Result<Vec<Identity>> {
	let dot_git = repo.root().join(".git");
	let mut protected = Vec::with_capacity(3);
	for path in [&dot_git, &repo.info().git_dir, &repo.info().common_dir] {
		match path_identity(path) {
			Ok(id) if !protected.contains(&id) => protected.push(id),
			Ok(_) => {},
			Err(err) if err.kind() == io::ErrorKind::NotFound => {},
			Err(err) => return Err(err),
		}
	}
	Ok(protected)
}

pub(super) fn identity(file: &File) -> io::Result<Identity> {
	let mut info = BY_HANDLE_FILE_INFORMATION::default();
	// SAFETY: The file handle is live and `info` is writable.
	if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &raw mut info) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok((
		u64::from(info.dwVolumeSerialNumber),
		(u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
	))
}

pub(super) fn entry_key(
	parent: &File,
	missing: &Path,
	leaf: &OsStr,
	protected: &[Identity],
) -> io::Result<EntryKey> {
	let id = identity(parent)?;
	let name = if missing.as_os_str().is_empty() {
		match open_relative(parent, leaf, FILE_READ_ATTRIBUTES, SHARE_ALL, FILE_OPEN, 0) {
			Ok(file) => {
				if protected.contains(&identity(&file)?) {
					return Err(io::Error::new(
						io::ErrorKind::PermissionDenied,
						"patch cannot write Git metadata",
					));
				}
				normalized_leaf(&file)?
			},
			Err(err) if matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::PermissionDenied) => {
				leaf.into()
			},
			Err(err) => return Err(err),
		}
	} else {
		missing.join(leaf)
	};
	let mut info = FILE_CASE_SENSITIVE_INFORMATION { Flags: 0 };
	let mut status = IO_STATUS_BLOCK::default();
	// SAFETY: The live parent, result and status block match the query class.
	let status = unsafe {
		NtQueryInformationFile(
			parent.as_raw_handle(),
			&raw mut status,
			(&raw mut info).cast(),
			size_of::<FILE_CASE_SENSITIVE_INFORMATION>() as u32,
			FileCaseSensitiveInformation,
		)
	};
	if status >= 0 && info.Flags & 1 != 0 {
		Ok((id, name))
	} else {
		Ok((id, name.to_string_lossy().to_uppercase().into()))
	}
}

fn normalized_leaf(file: &File) -> io::Result<PathBuf> {
	let mut path = vec![0_u16; 260];
	loop {
		// SAFETY: The file handle and output buffer are live.
		let length = unsafe {
			GetFinalPathNameByHandleW(file.as_raw_handle(), path.as_mut_ptr(), path.len() as u32, VOLUME_NAME_NT)
		} as usize;
		if length == 0 {
			return Err(io::Error::last_os_error());
		}
		if length < path.len() {
			// The normalized path reflects the opened link, not a file ID.
			// Thus separate hard-link names remain separate entries.
			let leaf = path[..length].rsplit(|unit| *unit == u16::from(b'\\')).next().unwrap_or_default();
			return Ok(OsString::from_wide(leaf).into());
		}
		path.resize(length + 1, 0);
	}
}

fn open_relative(
	parent: &File,
	name: &OsStr,
	access: u32,
	share: u32,
	disposition: NTCREATEFILE_CREATE_DISPOSITION,
	options: u32,
) -> io::Result<File> {
	let mut wide: Vec<_> = name.encode_wide().collect();
	let length =
		u16::try_from(wide.len() * size_of::<u16>()).map_err(|_| io::ErrorKind::InvalidInput)?;
	let name = UNICODE_STRING {
		Length:        length,
		MaximumLength: length,
		Buffer:        wide.as_mut_ptr(),
	};
	let attributes = OBJECT_ATTRIBUTES {
		Length:                   size_of::<OBJECT_ATTRIBUTES>() as u32,
		RootDirectory:            parent.as_raw_handle(),
		ObjectName:               &raw const name,
		Attributes:               OBJ_CASE_INSENSITIVE,
		SecurityDescriptor:       null(),
		SecurityQualityOfService: null(),
	};
	let mut handle: HANDLE = null_mut();
	let mut status_block = IO_STATUS_BLOCK::default();
	// SAFETY: The live objects and name buffer match the sizes in their
	// descriptors.
	let status = unsafe {
		NtCreateFile(
			&raw mut handle,
			access | SYNCHRONIZE,
			&raw const attributes,
			&raw mut status_block,
			null(),
			FILE_ATTRIBUTE_NORMAL,
			share,
			disposition,
			options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
			null(),
			0,
		)
	};
	check_status(status)?;
	// SAFETY: The successful open transferred ownership of the handle.
	Ok(unsafe { File::from_raw_handle(handle) })
}

fn check_status(status: NTSTATUS) -> io::Result<()> {
	if status < 0 {
		// SAFETY: This function only converts the status value.
		Err(io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32))
	} else {
		Ok(())
	}
}

pub(super) fn observe(parent: &File, name: &OsStr) -> Result<Option<Observation>> {
	let file = match open_relative(parent, name, FILE_READ_ATTRIBUTES | FILE_READ_DATA, SHARE_ALL, FILE_OPEN, 0) {
		Ok(file) => file,
		Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(err) => return Err(err.into()),
	};
	let observed = read_observation(&file, name)?;
	// Confirm that the name still resolves to the handle read above.
	let current = open_relative(parent, name, FILE_READ_ATTRIBUTES, SHARE_ALL, FILE_OPEN, 0)?;
	if identity(&current)? != observed.id {
		return Err(changed(name));
	}
	Ok(Some(observed))
}

fn read_observation(file: &File, name: &OsStr) -> Result<Observation> {
	let id = identity(file)?;
	let metadata = file.metadata()?;
	let (version, mode) = if metadata.file_type().is_symlink() {
		let target = read_link(file)?;
		let target = target
			.to_str()
			.ok_or_else(|| Error::backend("git owned patch", "non-UTF8 symlink target"))?;
		(raw_sha256(target.as_bytes())?, Mode::SYMLINK)
	} else if metadata.is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		(sha256_reader(file)?, Mode::FILE)
	} else {
		return Err(Error::backend(
			"git owned patch",
			format!("not a regular file or symlink: {}", name.display()),
		));
	};
	let current = file.metadata()?;
	if current.last_write_time() != metadata.last_write_time()
		|| current.file_size() != metadata.file_size()
		|| current.file_attributes() != metadata.file_attributes()
	{
		return Err(changed(name));
	}
	Ok(Observation { version, mode, id })
}

fn read_link(file: &File) -> io::Result<OsString> {
	let mut data = [0_u8; MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize];
	let mut used = 0;
	// SAFETY: The handle is synchronous and the output buffer is writable for
	// the given length.
	let ok = unsafe {
		DeviceIoControl(
			file.as_raw_handle(),
			FSCTL_GET_REPARSE_POINT,
			null(),
			0,
			data.as_mut_ptr().cast(),
			data.len() as u32,
			&raw mut used,
			null_mut(),
		)
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	let data = data
		.get(..used as usize)
		.ok_or(io::ErrorKind::InvalidData)?;
	let Some(header) = data.first_chunk::<16>() else {
		return Err(io::ErrorKind::InvalidData.into());
	};
	let tag = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
	// Reparse headers store byte offsets into the path buffer. Symlinks have
	// a four-byte Flags field before that buffer; junctions do not.
	let (base, relative) = match tag {
		IO_REPARSE_TAG_SYMLINK => (20, data.get(16).is_some_and(|flags| flags & 1 != 0)),
		IO_REPARSE_TAG_MOUNT_POINT => (16, false),
		_ => return Err(io::ErrorKind::InvalidData.into()),
	};
	let start = base + usize::from(u16::from_le_bytes([header[8], header[9]]));
	let length = usize::from(u16::from_le_bytes([header[10], header[11]]));
	let path = data
		.get(start..start + length)
		.ok_or(io::ErrorKind::InvalidData)?;
	let (pairs, remainder) = path.as_chunks::<2>();
	if !remainder.is_empty() {
		return Err(io::ErrorKind::InvalidData.into());
	}
	let mut wide: Vec<_> = pairs.iter().copied().map(u16::from_le_bytes).collect();
	if !relative && wide.starts_with(&[92, 63, 63, 92]) {
		// Match std::fs::read_link: do not expose the NT namespace, and strip
		// the verbatim prefix only if Windows would preserve the spelling.
		wide[1] = 92;
		if wide.len() < 260 {
			let friendly = match wide.as_mut_slice() {
				[_, _, _, _, _, 58, 92, ..] => Some(OsString::from_wide(&wide[4..])),
				[_, _, _, _, 85, 78, 67, 92, ..] => {
					wide[6] = 92;
					let friendly = OsString::from_wide(&wide[6..]);
					wide[6] = 67;
					Some(friendly)
				},
				_ => None,
			};
			if let Some(path) = friendly
				&& std::path::absolute(&path)?.as_os_str() == path.as_os_str()
			{
				return Ok(path);
			}
		}
	}
	Ok(OsString::from_wide(&wide))
}

pub(super) fn replace(
	parent: &File,
	name: &OsStr,
	bytes: &[u8],
	_mode: Mode,
	before: Option<&Observation>,
) -> Result<()> {
	// Windows checkout represents a Git symlink with a regular file of raw
	// target bytes, just as the ordinary patch API does.
	for staged in staging_names(name) {
		let mut file = match open_relative(
			parent,
			OsStr::new(&staged),
			FILE_GENERIC_WRITE | DELETE,
			FILE_SHARE_READ,
			FILE_CREATE,
			FILE_NON_DIRECTORY_FILE,
		) {
			Ok(file) => file,
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
			Err(err) => return Err(err.into()),
		};
		let mut published = false;
		let result = (|| -> Result<()> {
			file.write_all(bytes)?;
			let mut publish = || -> Result<()> {
				rename_without_replacing(&file, parent, name)?;
				published = true;
				Ok(())
			};
			if let Some(before) = before {
				replace_checked(parent, name, before, publish)
			} else {
				publish()
			}
		})();
		if !published {
			let _ = mark_for_deletion(&file);
		}
		return result;
	}
	Err(io::Error::from(io::ErrorKind::AlreadyExists).into())
}

fn rename_without_replacing(file: &File, parent: &File, name: &OsStr) -> io::Result<()> {
	let name_start = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
	let name_bytes = u16::try_from(name.encode_wide().count() * size_of::<u16>())
		.map_err(|_| io::ErrorKind::InvalidInput)?;
	let size = size_of::<FILE_RENAME_INFORMATION>() + usize::from(name_bytes);
	let mut buffer = vec![0_usize; size.div_ceil(size_of::<usize>())];
	let ptr = buffer.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
	let mut status_block = IO_STATUS_BLOCK::default();
	// SAFETY: The aligned buffer contains the header and the entire
	// variable-length name.
	let status = unsafe {
		ptr.write(FILE_RENAME_INFORMATION {
			Anonymous:      FILE_RENAME_INFORMATION_0 { Flags: 0 },
			RootDirectory:  parent.as_raw_handle(),
			FileNameLength: u32::from(name_bytes),
			FileName:       [0],
		});
		let out = ptr.cast::<u8>().add(name_start).cast::<u16>();
		for (i, unit) in name.encode_wide().enumerate() {
			out.add(i).write(unit);
		}
		NtSetInformationFile(
			file.as_raw_handle(),
			&raw mut status_block,
			ptr.cast(),
			size as u32,
			FileRenameInformationEx,
		)
	};
	check_status(status)
}

fn mark_for_deletion(file: &File) -> io::Result<()> {
	let disposition = FILE_DISPOSITION_INFORMATION_EX {
		Flags: FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS
			| FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE,
	};
	let mut status_block = IO_STATUS_BLOCK::default();
	// SAFETY: The disposition value and output status block are live for the
	// call.
	let status = unsafe {
		NtSetInformationFile(
			file.as_raw_handle(),
			&raw mut status_block,
			(&raw const disposition).cast(),
			size_of::<FILE_DISPOSITION_INFORMATION_EX>() as u32,
			FileDispositionInformationEx,
		)
	};
	check_status(status)
}

fn open_checked(parent: &File, name: &OsStr, before: &Observation) -> Result<File> {
	// Pin the checked entry by handle and deny competing write/delete opens.
	// Existing readers are allowed provided they shared delete access.
	let file = open_relative(
		parent,
		name,
		FILE_READ_ATTRIBUTES | FILE_READ_DATA | DELETE,
		FILE_SHARE_READ,
		FILE_OPEN,
		0,
	)?;
	if &read_observation(&file, name)? != before {
		return Err(changed(name));
	}
	Ok(file)
}

fn replace_checked(
	parent: &File,
	name: &OsStr,
	before: &Observation,
	publish: impl FnOnce() -> Result<()>,
) -> Result<()> {
	let displaced = open_checked(parent, name, before)?;
	for saved in staging_names(name) {
		let saved = OsStr::new(&saved);
		// Rename the checked handle, not whatever might be at its old path.
		// This also moves a directory symlink without following it or
		// attempting an unsupported file-over-directory replacement.
		match rename_without_replacing(&displaced, parent, saved) {
			Ok(()) => {},
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
			Err(err) => return Err(err.into()),
		}
		if let Err(err) = publish() {
			return Err(match rename_without_replacing(&displaced, parent, name) {
				Ok(()) => err,
				Err(restore) => recovery_error(name, saved, err, restore),
			});
		}
		return mark_for_deletion(&displaced).map_err(|err| {
			recovery_error(name, saved, io::Error::other("publication already performed").into(), err)
		});
	}
	Err(io::Error::from(io::ErrorKind::AlreadyExists).into())
}

pub(super) fn remove(parent: &File, name: &OsStr, before: &Observation) -> Result<()> {
	let file = open_checked(parent, name, before)?;
	mark_for_deletion(&file)?;
	Ok(())
}
