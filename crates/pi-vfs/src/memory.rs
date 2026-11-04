//! Host memory headroom shared by native streaming workloads.
use std::path::Path;

/// Currently available physical memory, further restricted by Linux cgroups.
/// Callers apply their own per-operation budget; this does not reserve memory.
pub fn available_bytes() -> Option<u128> {
	let system = system_available_bytes();
	#[cfg(target_os = "linux")]
	{
		match (system, cgroup_available_bytes()) {
			(Some(system), Some(cgroup)) => Some(system.min(cgroup)),
			(system, cgroup) => system.or(cgroup),
		}
	}
	#[cfg(not(target_os = "linux"))]
	system
}

/// Available physical memory without a workload's cgroup restriction.
pub fn system_available_bytes() -> Option<u128> {
	#[cfg(target_os = "linux")]
	{
		std::fs::read_to_string("/proc/meminfo")
			.ok()
			.as_deref()
			.and_then(meminfo_available_bytes)
	}
	#[cfg(target_os = "windows")]
	{
		use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
		// SAFETY: a zeroed MEMORYSTATUSEX is initialized by GlobalMemoryStatusEx
		// after dwLength is set to the size required by that API.
		let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
		status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
		// SAFETY: status points to a writable correctly sized structure.
		if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
			None
		} else {
			Some(u128::from(status.ullAvailPhys))
		}
	}
	#[cfg(not(any(target_os = "linux", target_os = "windows")))]
	None
}

/// Memory allowed by the process's cgroups, including reclaimable file pages.
#[cfg(target_os = "linux")]
pub fn cgroup_available_bytes() -> Option<u128> {
	let membership = std::fs::read_to_string("/proc/self/cgroup").ok()?;
	cgroup_memory_headroom(&membership, Path::new("/sys/fs/cgroup"))
}

/// Parse Linux meminfo, including the pre-MemAvailable kernel fallback.
/// Values in the proc file are KiB, not bytes.
pub fn meminfo_available_bytes(meminfo: &str) -> Option<u128> {
	let field = |name: &str| -> Option<u128> {
		meminfo
			.lines()
			.find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))?
			.split_ascii_whitespace()
			.next()?
			.parse::<u128>()
			.ok()
	};
	let kib = field("MemAvailable").or_else(|| {
		Some(field("MemFree")? + field("Buffers").unwrap_or(0) + field("Cached").unwrap_or(0))
	})?;
	Some(kib * 1024)
}

/// Resolve the tightest cgroup v1/v2 ancestor headroom under a mount root.
pub fn cgroup_memory_headroom(membership: &str, root: &Path) -> Option<u128> {
	for line in membership.lines() {
		let mut fields = line.splitn(3, ':');
		let (Some(_), Some(controllers), Some(path)) = (fields.next(), fields.next(), fields.next())
		else {
			continue;
		};
		let relative = path.trim_start_matches('/');
		let headroom = if controllers.is_empty() {
			headroom_along(&root.join(relative), root, &CGROUP_V2)
		} else if controllers
			.split(',')
			.any(|controller| controller == "memory")
		{
			let base = root.join("memory");
			headroom_along(&base.join(relative), &base, &CGROUP_V1)
		} else {
			None
		};
		if headroom.is_some() {
			return headroom;
		}
	}
	None
}

struct MemoryFiles {
	limits:      &'static [&'static str],
	usage:       &'static str,
	reclaimable: &'static str,
}
const CGROUP_V2: MemoryFiles = MemoryFiles {
	limits:      &["memory.max", "memory.high"],
	usage:       "memory.current",
	reclaimable: "inactive_file",
};
const CGROUP_V1: MemoryFiles = MemoryFiles {
	limits:      &["memory.limit_in_bytes"],
	usage:       "memory.usage_in_bytes",
	reclaimable: "total_inactive_file",
};

fn headroom_along(dir: &Path, top: &Path, files: &MemoryFiles) -> Option<u128> {
	let read = |dir: &Path, name: &str| -> Option<u128> {
		std::fs::read_to_string(dir.join(name))
			.ok()?
			.trim()
			.parse()
			.ok()
	};
	let reclaimable = |dir: &Path| -> Option<u128> {
		let stat = std::fs::read_to_string(dir.join("memory.stat")).ok()?;
		stat.lines().find_map(|line| {
			line
				.strip_prefix(files.reclaimable)?
				.strip_prefix(' ')?
				.parse()
				.ok()
		})
	};
	let mut smallest: Option<u128> = None;
	let mut level = Some(dir);
	while let Some(dir) = level {
		if let Some(limit) = files.limits.iter().filter_map(|name| read(dir, name)).min() {
			let usage = read(dir, files.usage)
				.unwrap_or(0)
				.saturating_sub(reclaimable(dir).unwrap_or(0));
			let headroom = limit.saturating_sub(usage);
			smallest = Some(smallest.map_or(headroom, |smallest| smallest.min(headroom)));
		}
		if dir == top {
			break;
		}
		level = dir.parent().filter(|parent| parent.starts_with(top));
	}
	smallest
}
