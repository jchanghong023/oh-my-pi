use std::{
	ffi::{OsStr, OsString},
	fs::{File, OpenOptions},
	io::{self, Write},
	os::windows::{
		ffi::{OsStrExt, OsStringExt},
		fs::{MetadataExt, OpenOptionsExt},
		io::{AsRawHandle, FromRawHandle},
	},
	path::Path,
	ptr::{null, null_mut},
};

use gix::index::entry::Mode;
use windows_sys::{
	Wdk::{
		Foundation::OBJECT_ATTRIBUTES,
		Storage::FileSystem::{
			FILE_CREATE, FILE_DIRECTORY_FILE, FILE_DISPOSITION_INFORMATION, FILE_NON_DIRECTORY_FILE,
			FILE_OPEN, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_RENAME_INFORMATION_0,
			FILE_SYNCHRONOUS_IO_NONALERT, FileDispositionInformation, FileRenameInformation,
			NTCREATEFILE_CREATE_DISPOSITION, NtCreateFile, NtSetInformationFile,
		},
	},
	Win32::{
		Foundation::{HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, UNICODE_STRING},
		Storage::FileSystem::{
			DELETE, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
			FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
			FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
			MAXIMUM_REPARSE_DATA_BUFFER_SIZE, SYNCHRONIZE,
		},
		System::{
			IO::{DeviceIoControl, IO_STATUS_BLOCK},
			Ioctl::FSCTL_GET_REPARSE_POINT,
			SystemServices::{IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK},
		},
	},
};

use super::staging_names;
use crate::{
	error::{Error, Result},
	git::mutate::{raw_sha256, sha256_reader},
};

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const DIRECTORY_ACCESS: u32 = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

pub(in super::super) fn open_root(path: &Path) -> io::Result<File> {
	let file = OpenOptions::new()
		.access_mode(DIRECTORY_ACCESS)
		.share_mode(SHARE_ALL)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
		.open(path)?;
	checked_directory(file)
}

pub(super) fn open_child(parent: &File, name: &OsStr, create: bool) -> io::Result<File> {
	let disposition = if create { FILE_CREATE } else { FILE_OPEN };
	checked_directory(open_relative(
		parent,
		name,
		DIRECTORY_ACCESS,
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

fn open_relative(
	parent: &File,
	name: &OsStr,
	access: u32,
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
			SHARE_ALL,
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

pub(super) fn observe(parent: &File, name: &OsStr) -> Result<Option<(String, Mode)>> {
	let file = match open_relative(parent, name, FILE_READ_ATTRIBUTES | FILE_READ_DATA, FILE_OPEN, 0)
	{
		Ok(file) => file,
		Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(err) => return Err(err.into()),
	};
	let metadata = file.metadata()?;
	if metadata.file_type().is_symlink() {
		let target = read_link(&file)?;
		let target = target
			.to_str()
			.ok_or_else(|| Error::backend("git owned patch", "non-UTF8 symlink target"))?;
		Ok(Some((raw_sha256(target.as_bytes())?, Mode::SYMLINK)))
	} else if metadata.is_file() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		Ok(Some((sha256_reader(file)?, Mode::FILE)))
	} else {
		Err(Error::backend(
			"git owned patch",
			format!("not a regular file or symlink: {}", name.display()),
		))
	}
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

pub(super) fn replace(parent: &File, name: &OsStr, bytes: &[u8], _mode: Mode) -> io::Result<()> {
	// Windows checkout represents a Git symlink with a regular file of raw
	// target bytes, just as the ordinary patch API does.
	for staged in staging_names(name) {
		let mut file = match open_relative(
			parent,
			OsStr::new(&staged),
			FILE_GENERIC_WRITE | DELETE,
			FILE_CREATE,
			FILE_NON_DIRECTORY_FILE,
		) {
			Ok(file) => file,
			Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
			Err(err) => return Err(err),
		};
		let result = file
			.write_all(bytes)
			.and_then(|()| rename(&file, parent, name));
		if result.is_err() {
			let _ = mark_for_deletion(&file);
		}
		return result;
	}
	Err(io::ErrorKind::AlreadyExists.into())
}

fn rename(file: &File, parent: &File, name: &OsStr) -> io::Result<()> {
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
			Anonymous:      FILE_RENAME_INFORMATION_0 { ReplaceIfExists: true },
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
			FileRenameInformation,
		)
	};
	check_status(status)
}

fn mark_for_deletion(file: &File) -> io::Result<()> {
	let disposition = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
	let mut status_block = IO_STATUS_BLOCK::default();
	// SAFETY: The disposition value and output status block are live for the
	// call.
	let status = unsafe {
		NtSetInformationFile(
			file.as_raw_handle(),
			&raw mut status_block,
			(&raw const disposition).cast(),
			size_of::<FILE_DISPOSITION_INFORMATION>() as u32,
			FileDispositionInformation,
		)
	};
	check_status(status)
}

pub(super) fn remove(parent: &File, name: &OsStr) -> io::Result<()> {
	let file = match open_relative(parent, name, DELETE | FILE_READ_ATTRIBUTES, FILE_OPEN, 0) {
		Ok(file) => file,
		Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(err) => return Err(err),
	};
	let kind = file.metadata()?.file_type();
	if kind.is_file() || kind.is_symlink() {
		mark_for_deletion(&file)
	} else {
		Err(io::ErrorKind::InvalidInput.into())
	}
}
