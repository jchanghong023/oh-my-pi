//! Cancellable Python definition extraction through the shared AST cache.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

#[napi(object)]
pub struct PythonSymbolsOptions<'env> {
	pub code:   String,
	pub signal: Option<Unknown<'env>>,
}

#[napi(object)]
pub struct PythonSymbol {
	pub name:       String,
	pub qualname:   String,
	pub kind:       String,
	pub start_line: u32,
	pub end_line:   u32,
	pub signature:  Option<String>,
}

impl From<pi_ast::python_symbols::PythonSymbol> for PythonSymbol {
	fn from(symbol: pi_ast::python_symbols::PythonSymbol) -> Self {
		Self {
			name:       symbol.name,
			qualname:   symbol.qualname,
			kind:       symbol.kind.to_owned(),
			start_line: symbol.start_line,
			end_line:   symbol.end_line,
			signature:  Some(symbol.signature),
		}
	}
}

#[napi(object)]
pub struct PythonSymbolsResult {
	pub symbols:     Vec<PythonSymbol>,
	pub parse_error: bool,
}

#[napi]
pub fn python_symbols(options: PythonSymbolsOptions<'_>) -> task::Promise<PythonSymbolsResult> {
	let PythonSymbolsOptions { code, signal } = options;
	let token = task::CancelToken::new(None, signal);
	task::blocking("python_symbols", token, move |token| {
		let result = pi_ast::python_symbols::extract_python_symbols(&code, || {
			token
				.heartbeat()
				.map_err(|error| anyhow::anyhow!(error.to_string()))
		})
		.map_err(|error| Error::from_reason(error.to_string()))?;
		Ok(PythonSymbolsResult {
			symbols:     result.symbols.into_iter().map(Into::into).collect(),
			parse_error: result.parse_error,
		})
	})
}
