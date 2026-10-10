#![cfg_attr(windows, windows_subsystem = "windows")]

//! Native Windows entry points keep Cargo/rustdoc arguments out of cmd.exe.
//! Only dispatch lives here; compiler accounting and wrapper stacking stay in
//! Bun.
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
	env, io,
	path::Path,
	process::{self, Command},
};

fn run() -> io::Result<i32> {
	let executable = env::current_exe()?;
	let name = executable.file_stem().and_then(|name| name.to_str());
	let (script_variable, mode) = match name {
		Some("test-gate-rustc") => ("OMP_GATE_COMPILER_SCRIPT", None),
		Some("test-gate-rustdoc") => ("OMP_GATE_RUSTDOC_SCRIPT", None),
		Some("test-gate-doctest-compile") => ("OMP_GATE_COMPILER_SCRIPT", Some("--doctest-compile")),
		Some("test-gate-doctest-run") => ("OMP_GATE_COMPILER_SCRIPT", Some("--doctest-run")),
		_ => {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"unknown gate launcher entry point",
			));
		},
	};
	let required = |variable| {
		env::var_os(variable)
			.filter(|value| !value.is_empty())
			.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, format!("missing {variable}")))
	};
	let bun = required("OMP_GATE_BUN_BINARY")?;
	let script = required(script_variable)?;
	// The executable entry and Bun both use native process spawning. OsString
	// retains Windows argument contents without shell interpolation or a join.
	let mut command = Command::new(Path::new(&bun));
	#[cfg(windows)]
	command.creation_flags(0x08000000); // CREATE_NO_WINDOW; keep inherited stdio handles.
	command.arg(script);
	if let Some(mode) = mode {
		command.arg(mode);
	}
	command.args(env::args_os().skip(1));
	Ok(command.status()?.code().unwrap_or(1))
}

fn main() {
	match run() {
		Ok(code) => process::exit(code),
		Err(error) => {
			eprintln!("gate launcher: {error}");
			process::exit(if error.kind() == io::ErrorKind::NotFound {
				127
			} else {
				1
			});
		},
	}
}
