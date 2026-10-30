//! JavaScript bindings for wiki storage.

use napi_derive::napi;
pub(super) use pi_wiki::storage::{
	BuildIdentity, Storage, StorageDiagnostic, StorageDiagnosticHook,
};

#[napi(object)]
#[derive(Clone, Debug)]
pub struct WikiIndexSummary {
	pub id:             i64,
	pub name:           String,
	pub root_path:      String,
	pub document_count: i64,
	pub section_count:  i64,
}

impl From<pi_wiki::storage::WikiIndexSummary> for WikiIndexSummary {
	fn from(value: pi_wiki::storage::WikiIndexSummary) -> Self {
		Self {
			id:             value.id,
			name:           value.name,
			root_path:      value.root_path,
			document_count: value.document_count,
			section_count:  value.section_count,
		}
	}
}

#[napi]
pub fn wiki_normalize_fts(text: String) -> String {
	pi_wiki::storage::normalize_fts(&text)
}

#[cfg(test)]
mod owner_cleanup_tests {
	use std::{
		fs,
		sync::{
			Arc,
			atomic::{AtomicBool, AtomicUsize},
		},
	};

	use super::{
		super::{ImportGuard, Owner, StorageState, WikiSearchEngine, database::DatabaseEngine},
		*,
	};
	use crate::task::{AbortReason, CancelToken};

	#[test]
	fn owner_rolls_back_accepted_build_after_cancellation_and_close() {
		for close in [false, true] {
			let directory = std::env::temp_dir().join(format!(
				"omp-wiki-owner-{}-{}",
				std::process::id(),
				std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap()
					.as_nanos()
			));
			let path = directory.join("docs.db").to_string_lossy().into_owned();
			let storage = Storage::open_with_diagnostics(&path, Arc::new(|_, _| {})).unwrap();
			let identity = storage.identity().to_owned();
			let owner = Arc::new(Owner {
				closed:        Arc::new(AtomicBool::new(false)),
				imports:       AtomicUsize::new(1),
				engine:        parking_lot::Mutex::new(DatabaseEngine::new(path.clone(), path.clone())),
				storage:       parking_lot::Mutex::new(StorageState {
					storage: Some(storage),
					identity,
				}),
				database_path: path,
				diagnostics:   Arc::new(parking_lot::Mutex::new(Vec::new())),
			});
			let guard = ImportGuard(Arc::clone(&owner));
			let mut cancel = CancelToken::default();
			let build = owner
				.with_storage(&cancel, |storage| storage.create("__building__cancelled", "/source"))
				.unwrap();
			let source = b"# Lifetime\nneedle evidence\n";
			let parsed = pi_wiki::import::parse_markdown(source).unwrap();
			let document = pi_wiki::import::WikiMarkdownDocument {
				relative_path: "lifetime.md".into(),
				title:         parsed.title.unwrap(),
				source_kind:   "markdown".into(),
				sha256:        "lifetime-hash".into(),
				size_bytes:    source.len() as i64,
				mtime_ms:      0.0,
				sections:      parsed.sections,
			};
			owner
				.with_storage(&cancel, |storage| {
					storage.commit_document(&build, &document, &|| owner.check_import(&cancel))
				})
				.unwrap();
			cancel.emplace_abort_token().abort(AbortReason::Signal);
			let engine = WikiSearchEngine { owner: Arc::clone(&owner) };
			if close {
				engine.close();
			}
			assert!(owner.check_import(&cancel).is_err());
			owner.rollback(&build).unwrap();
			{
				let connection = rusqlite::Connection::open(&owner.database_path).unwrap();
				let indexes: i64 = connection
					.query_row(
						"SELECT count(*) FROM doc_indexes WHERE name=?",
						["__building__cancelled"],
						|row| row.get(0),
					)
					.unwrap();
				assert_eq!(indexes, 0);
				let rows: i64 = connection
					.query_row("SELECT count(*) FROM sections_fts", [], |row| row.get(0))
					.unwrap();
				assert_eq!(rows, 0);
			}
			drop(engine);
			drop(guard);
			assert!(owner.storage.lock().storage.is_none());
			drop(owner);
			fs::remove_dir_all(directory).unwrap();
		}
	}
}
