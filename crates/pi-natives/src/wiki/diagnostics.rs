//! Content-free diagnostics and acknowledged JavaScript callback delivery.
use std::{
	sync::{Arc, mpsc},
	thread::{self, ThreadId},
	time::Instant,
};

use napi::{
	Error, Result, Status,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, UnknownReturnValue},
};
use napi_derive::napi;
use parking_lot::Mutex;

use super::{
	database::WikiError,
	storage::{StorageDiagnostic, StorageDiagnosticHook},
};

#[derive(Default)]
#[napi(object, object_from_js = false)]
pub struct WikiDiagnosticEvent {
	pub message:               String,
	pub level:                 String,
	pub component:             String,
	pub event:                 String,
	pub stage:                 String,
	pub result:                String,
	pub elapsed_ms:            Option<f64>,
	pub file_count:            Option<i64>,
	pub document_count:        Option<i64>,
	pub section_count:         Option<i64>,
	pub index_count:           Option<i64>,
	pub abandoned_index_count: Option<i64>,
	pub retry_limit:           Option<i64>,
	pub schema_version:        Option<i64>,
	pub supported_version:     Option<i64>,
	pub from_version:          Option<i64>,
	pub to_version:            Option<i64>,
	pub index_id:              Option<i64>,
	pub index_hash:            Option<String>,
	pub cleanup:               Option<String>,
	pub rollback:              Option<String>,
	pub failed_stage:          Option<String>,
	pub reason:                Option<String>,
	pub error_type:            Option<String>,
	pub error_code:            Option<String>,
	pub error_errno:           Option<i32>,
}
impl WikiDiagnosticEvent {
	pub(super) fn operation(
		message: &str,
		event: &str,
		stage: &str,
		result: &str,
		started: Instant,
	) -> Self {
		Self {
			message: message.into(),
			level: "info".into(),
			component: "docs".into(),
			event: event.into(),
			stage: stage.into(),
			result: result.into(),
			elapsed_ms: Some(started.elapsed().as_secs_f64() * 1000.0),
			..Self::default()
		}
	}

	pub(super) fn error(&mut self, error: &WikiError) {
		self.error_type = Some(error.diagnostic_error_type().into());
		self.error_code = error.diagnostic_code().map(str::to_owned);
		self.error_errno = error.diagnostic_sqlite_code();
	}
}
pub(super) type DiagnosticQueue = Arc<Mutex<Vec<(ThreadId, WikiDiagnosticEvent)>>>;
pub(super) fn enqueue(queue: &DiagnosticQueue, event: WikiDiagnosticEvent) {
	queue.lock().push((thread::current().id(), event));
}
fn take_current(queue: &DiagnosticQueue) -> Vec<WikiDiagnosticEvent> {
	let current = thread::current().id();
	queue
		.lock()
		.extract_if(.., |(thread, _)| *thread == current)
		.map(|(_, event)| event)
		.collect()
}
pub(super) fn storage_hook(queue: DiagnosticQueue) -> StorageDiagnosticHook {
	Arc::new(move |value: StorageDiagnostic, error: Option<&WikiError>| {
		let mut event = WikiDiagnosticEvent {
			message: value.message.into(),
			level: value.level.into(),
			component: value.component.into(),
			event: value.event.into(),
			stage: value.stage.into(),
			result: value.result.into(),
			elapsed_ms: value.elapsed_ms,
			schema_version: value.schema_version,
			supported_version: value.supported_version,
			from_version: value.from_version,
			to_version: value.to_version,
			section_count: value.section_count,
			document_count: value.document_count,
			abandoned_index_count: value.abandoned_index_count,
			index_id: value.index_id,
			index_hash: value.index_hash,
			cleanup: value.cleanup.map(str::to_owned),
			rollback: value.rollback.map(str::to_owned),
			..WikiDiagnosticEvent::default()
		};
		if let Some(error) = error {
			event.error(error);
		}
		enqueue(&queue, event);
	})
}
pub(super) type DiagnosticFunction<'a> = Function<'a, WikiDiagnosticEvent, UnknownReturnValue>;
pub(super) type DiagnosticCallback = ThreadsafeFunction<
	WikiDiagnosticEvent,
	UnknownReturnValue,
	WikiDiagnosticEvent,
	Status,
	false,
	false,
>;

/// `UnknownReturnValue` deliberately ignores returned Promises. Only a
/// synchronous throw fails the checkpoint; the original JS Error reference is
/// retained.
pub(super) struct CallbackFailure {
	pub error:      Error,
	pub error_type: String,
}
impl CallbackFailure {
	fn new(error: Error) -> Self {
		Self { error, error_type: "Error".into() }
	}
}
pub(super) fn acknowledge_named<T: ToNapiValue + Send + 'static>(
	callback: &ThreadsafeFunction<T, UnknownReturnValue, T, Status, false, false>,
	value: T,
) -> std::result::Result<(), CallbackFailure> {
	let (sender, receiver) = mpsc::sync_channel(1);
	let status = callback.call_with_return_value(
		value,
		ThreadsafeFunctionCallMode::NonBlocking,
		move |returned: Result<UnknownReturnValue>, env: napi::Env| {
			let returned = returned.map(|_| ()).map_err(|error| {
				let name = error
					.try_clone()
					.and_then(|copy| env.create_error(copy))
					.and_then(|object| object.get_named_property::<String>("name"))
					.unwrap_or_else(|_| "UnknownError".into());
				let prefix = name.strip_suffix("Error");
				let permitted = name == "Error"
					|| name == "DOMException"
					|| prefix.is_some_and(|prefix| {
						let bytes = prefix.as_bytes();
						!bytes.is_empty()
							&& bytes.len() <= 49
							&& bytes[0].is_ascii_alphabetic()
							&& bytes.iter().all(u8::is_ascii_alphanumeric)
					});
				let error_type = if permitted {
					name
				} else {
					"UnknownError".into()
				};
				CallbackFailure { error, error_type }
			});
			let _ = sender.send(returned);
			Ok(())
		},
	);
	if status != Status::Ok {
		return Err(CallbackFailure::new(Error::new(
			status,
			"Documentation callback is no longer callable",
		)));
	}
	receiver.recv().map_err(|_| {
		CallbackFailure::new(Error::from_reason("Documentation callback acknowledgement was lost"))
	})?
}
pub(super) fn acknowledge<T: ToNapiValue + Send + 'static>(
	callback: &ThreadsafeFunction<T, UnknownReturnValue, T, Status, false, false>,
	value: T,
) -> Result<()> {
	acknowledge_named(callback, value).map_err(|failure| failure.error)
}
pub(super) fn flush_sync(
	queue: &DiagnosticQueue,
	callback: Option<&DiagnosticFunction<'_>>,
) -> Result<()> {
	let events = take_current(queue);
	if let Some(callback) = callback {
		for event in events {
			callback.call(event)?;
		}
	}
	Ok(())
}
pub(super) fn flush_async(
	queue: &DiagnosticQueue,
	callback: Option<&DiagnosticCallback>,
) -> Result<()> {
	let events = take_current(queue);
	if let Some(callback) = callback {
		for event in events {
			acknowledge(callback, event)?;
		}
	}
	Ok(())
}
