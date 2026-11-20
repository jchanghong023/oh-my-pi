use super::*;

fn fixture() -> Connection {
	let connection = Connection::open_in_memory().unwrap();
	connection
		.execute_batch(
			"CREATE TABLE doc_indexes(id INTEGER PRIMARY KEY,name TEXT,root_path TEXT);
		 CREATE TABLE documents(id INTEGER PRIMARY KEY,index_id INTEGER,relative_path TEXT,title \
			 TEXT,source_kind TEXT,sha256 TEXT,size_bytes INTEGER,mtime_ms REAL);
		 CREATE TABLE sections(id INTEGER PRIMARY KEY,document_id INTEGER,index_id INTEGER,ordinal \
			 INTEGER,byte_start INTEGER,byte_end INTEGER,heading_level INTEGER,heading_path \
			 TEXT,line_start INTEGER,line_end INTEGER,raw_markdown TEXT);
		 INSERT INTO doc_indexes VALUES(1,'published','/docs'),(2,'__building__hidden','/hidden');
		 INSERT INTO documents \
			 VALUES(1,1,'doc.md','Title','markdown','hash',42,1.5),(2,2,'hidden.md','Hidden','\
			 markdown','hidden',1,0.0);",
		)
		.unwrap();
	for id in 1..=BATCH_ROWS * 3 + 1 {
		let text = if id == BATCH_ROWS + 2 {
			"大".repeat(BATCH_BYTES)
		} else {
			format!("row {id}: \"quoted\"\n\\")
		};
		connection
			.execute(
				"INSERT INTO sections VALUES(?1,1,1,?1,0,?2,1,'Heading',1,2,?3)",
				rusqlite::params![id as i64, text.len() as i64, text],
			)
			.unwrap();
	}
	connection
		.execute("INSERT INTO sections VALUES(99999,2,2,0,0,6,1,'Hidden',1,1,'hidden')", [])
		.unwrap();
	connection
}

fn serial_digest(connection: &Connection) -> Vec<u8> {
	let mut hash = Sha256::new();
	let mut output = String::new();
	for sql in [INDEX_ROWS, SECTION_ROWS] {
		let mut statement = connection.prepare(sql).unwrap();
		let mut rows = statement.query([]).unwrap();
		while let Some(row) = rows.next().unwrap() {
			hash_row(&mut hash, row, &mut output).unwrap();
		}
	}
	hash.finalize().to_vec()
}

// Parallel batches, oversized fallback rows and hidden builds preserve legacy
// cursor bytes.
#[test]
fn snapshot_batches_preserve_serial_digest_and_sql_order() {
	let connection = fixture();
	let expected = serial_digest(&connection);
	let pool = rayon::ThreadPoolBuilder::new()
		.num_threads(2)
		.build()
		.unwrap();
	let actual = pool.in_place_scope(|scope| {
		let mut pipeline = Pipeline {
			scope,
			workers: 2,
			check: || Ok(()),
			stopped: Arc::new(AtomicBool::new(false)),
			pending: VecDeque::new(),
			snapshot: Sha256::new(),
		};
		pipeline.read(&connection).unwrap();
		assert!(pipeline.pending.is_empty());
		std::mem::take(&mut pipeline.snapshot).finalize().to_vec()
	});
	assert_eq!(actual, expected);
	assert_eq!(
		compute(&connection, &|| Ok(()))
			.unwrap()
			.finalize()
			.to_vec(),
		expected
	);
	connection
		.execute("UPDATE sections SET raw_markdown='ignored' WHERE index_id=2", [])
		.unwrap();
	assert_eq!(
		compute(&connection, &|| Ok(()))
			.unwrap()
			.finalize()
			.to_vec(),
		expected
	);
	connection
		.execute("UPDATE sections SET raw_markdown='changed' WHERE id=1", [])
		.unwrap();
	assert_ne!(
		compute(&connection, &|| Ok(()))
			.unwrap()
			.finalize()
			.to_vec(),
		expected
	);
}

// Owned batches preserve SQLite storage classes, escaping, and numeric cursor
// serialization.
#[test]
fn batch_encoding_preserves_all_sqlite_value_types() {
	let connection = Connection::open_in_memory().unwrap();
	let mut statement = connection
		.prepare(
			"SELECT NULL AS n,9223372036854775807 AS i,-0.0 AS r,CAST(x'61ff0a225c' AS TEXT) AS \
			 t,x'00ff10' AS b",
		)
		.unwrap();
	let mut rows = statement.query([]).unwrap();
	let row = rows.next().unwrap().unwrap();
	let mut batch = Batch::default();
	batch.push(row).unwrap();
	let mut expected = String::new();
	hash_row(&mut Sha256::new(), row, &mut expected).unwrap();
	let prefixes = ["\"n\":", ",\"i\":", ",\"r\":", ",\"t\":", ",\"b\":"].map(str::to_owned);
	assert_eq!(batch.encode(&prefixes, &|| Ok(())).unwrap(), expected);
	assert_eq!(batch.rows, 1);
	assert_eq!(batch.bytes.len(), 8);
}

// Cancellation retains the original error and leaves the connection reusable.
#[test]
fn snapshot_cancellation_preserves_error_and_allows_retry() {
	let connection = fixture();
	let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
	let observed = Arc::clone(&calls);
	let check = move || {
		if observed.fetch_add(1, Ordering::Relaxed) >= BATCH_ROWS + 8 {
			Err(KnowledgeError::message("snapshot test cancellation"))
		} else {
			Ok(())
		}
	};
	let error = match compute(&connection, &check) {
		Ok(_) => panic!("cancelled snapshot must not publish a hash"),
		Err(error) => error,
	};
	assert_eq!(error.message, "snapshot test cancellation");
	assert!(calls.load(Ordering::Relaxed) > BATCH_ROWS + 8);
	assert_eq!(
		compute(&connection, &|| Ok(()))
			.unwrap()
			.finalize()
			.to_vec(),
		serial_digest(&connection)
	);
}
