//! Python definition extraction from the shared cached Tree-sitter parse.

use anyhow::Result;
use tree_sitter::Node;

use crate::{SupportLang, parse_cache::parse_cached};

#[derive(Debug, PartialEq, Eq)]
pub struct PythonSymbol {
	pub name:       String,
	pub qualname:   String,
	pub kind:       &'static str,
	pub start_line: u32,
	pub end_line:   u32,
	pub signature:  String,
}

#[derive(Debug, Default)]
pub struct PythonSymbolsResult {
	pub symbols:     Vec<PythonSymbol>,
	pub parse_error: bool,
}

/// Extract definitions in source order.
///
/// A syntax error invalidates the entire symbol set: callers must never retain
/// definitions from an older parse. `heartbeat` runs before and after parsing
/// and throughout the tree walk.
pub fn extract_python_symbols(
	code: &str,
	mut heartbeat: impl FnMut() -> Result<()>,
) -> Result<PythonSymbolsResult> {
	heartbeat()?;
	let tree = parse_cached(code, SupportLang::Python)?;
	heartbeat()?;
	let Some(tree) = tree else {
		return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
	};
	if tree.root_node().has_error() {
		return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
	}
	let mut symbols = Vec::new();
	let mut qualification = String::new();
	visit(tree.root_node(), code, &mut qualification, false, None, &mut symbols, &mut heartbeat)?;
	heartbeat()?;
	Ok(PythonSymbolsResult { symbols, parse_error: false })
}

fn visit(
	node: Node<'_>,
	code: &str,
	qualification: &mut String,
	class_owner: bool,
	decorated_start: Option<Node<'_>>,
	symbols: &mut Vec<PythonSymbol>,
	heartbeat: &mut impl FnMut() -> Result<()>,
) -> Result<()> {
	heartbeat()?;
	if node.kind() == "decorated_definition" {
		if let Some(definition) = node.child_by_field_name("definition") {
			visit(definition, code, qualification, class_owner, Some(node), symbols, heartbeat)?;
		}
		return Ok(());
	}
	let is_class = node.kind() == "class_definition";
	if is_class || node.kind() == "function_definition" {
		let Some(name_node) = node.child_by_field_name("name") else {
			return Ok(());
		};
		let Some(body) = node.child_by_field_name("body") else {
			return Ok(());
		};
		let Some(name) = code.get(name_node.byte_range()) else {
			return Ok(());
		};
		let original_len = qualification.len();
		if !qualification.is_empty() {
			qualification.push('.');
		}
		qualification.push_str(name);
		// The final direct `:` token belongs to the declaration, not a colon
		// inside a parameter annotation/default or superclass expression.
		let mut cursor = node.walk();
		let signature_end = node
			.children(&mut cursor)
			.filter(|child| child.kind() == ":" && child.end_byte() <= body.start_byte())
			.map(|child| child.end_byte())
			.last();
		if let Some(signature) =
			signature_end.and_then(|end| code.get(decorated_start.unwrap_or(node).start_byte()..end))
		{
			symbols.push(PythonSymbol {
				name:       name.to_owned(),
				qualname:   qualification.clone(),
				kind:       if is_class {
					"class"
				} else if class_owner {
					"method"
				} else {
					"function"
				},
				start_line: decorated_start
					.unwrap_or(node)
					.start_position()
					.row
					.saturating_add(1)
					.min(u32::MAX as usize) as u32,
				end_line:   body
					.end_position()
					.row
					.saturating_add(usize::from(body.end_position().column != 0))
					.min(u32::MAX as usize) as u32,
				signature:  signature.to_owned(),
			});
		}
		visit(body, code, qualification, is_class, None, symbols, heartbeat)?;
		qualification.truncate(original_len);
		return Ok(());
	}
	let mut cursor = node.walk();
	for child in node.named_children(&mut cursor) {
		visit(child, code, qualification, class_owner, None, symbols, heartbeat)?;
	}
	Ok(())
}
