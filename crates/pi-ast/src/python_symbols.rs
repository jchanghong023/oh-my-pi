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
	let tree = parse_cached(code, SupportLang::Python, None)?;
	heartbeat()?;
	let Some(tree) = tree else {
		return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
	};
	if tree.root_node().has_error() {
		return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
	}
	let mut symbols = Vec::new();
	let mut qualification = String::new();
	if !visit(tree.root_node(), code, &mut qualification, &mut symbols, &mut heartbeat)? {
		return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
	}
	heartbeat()?;
	Ok(PythonSymbolsResult { symbols, parse_error: false })
}

fn visit(
	node: Node<'_>,
	code: &str,
	qualification: &mut String,
	symbols: &mut Vec<PythonSymbol>,
	heartbeat: &mut impl FnMut() -> Result<()>,
) -> Result<bool> {
	// Expression trees can be arbitrarily deep (for example a long addition
	// chain). Keep traversal state on Tree-sitter's cursor, not the native
	// stack.
	let mut cursor = node.walk();
	let mut scopes = Vec::new();
	let mut class_owner = false;
	'walk: loop {
		heartbeat()?;
		let node = cursor.node();
		// Tree-sitter accepts empty suites without marking the tree as erroneous.
		// Python requires a statement even when the suite contains comments.
		if node.kind() == "block" {
			let mut children = node.walk();
			if !node
				.named_children(&mut children)
				.any(|child| !child.is_extra())
			{
				return Ok(false);
			}
		}
		if let Some(original_len) =
			collect_definition(node, code, qualification, class_owner, symbols)
		{
			scopes.push((node.id(), original_len, class_owner));
			class_owner = node.kind() == "class_definition";
		}
		if cursor.goto_first_child() {
			loop {
				if cursor.node().is_named() {
					continue 'walk;
				}
				if !cursor.goto_next_sibling() {
					cursor.goto_parent();
					break;
				}
			}
		}
		loop {
			if scopes
				.last()
				.is_some_and(|&(id, ..)| id == cursor.node().id())
			{
				let (_, original_len, previous_owner) = scopes.pop().unwrap();
				qualification.truncate(original_len);
				class_owner = previous_owner;
			}
			while cursor.goto_next_sibling() {
				if cursor.node().is_named() {
					continue 'walk;
				}
			}
			if !cursor.goto_parent() {
				return Ok(true);
			}
		}
	}
}

fn collect_definition(
	node: Node<'_>,
	code: &str,
	qualification: &mut String,
	class_owner: bool,
	symbols: &mut Vec<PythonSymbol>,
) -> Option<usize> {
	let is_class = node.kind() == "class_definition";
	if is_class || node.kind() == "function_definition" {
		let name_node = node.child_by_field_name("name")?;
		let body = node.child_by_field_name("body")?;
		let name = code.get(name_node.byte_range())?;
		let decorated_start = node
			.parent()
			.filter(|parent| parent.kind() == "decorated_definition");
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
		return Some(original_len);
	}
	None
}

#[cfg(test)]
mod tests {
	use super::extract_python_symbols;

	#[test]
	fn empty_suites_discard_all_definitions() {
		for tail in [
			"def broken():\n",
			"def broken():\n    # comment\n",
			"class Broken:\n",
			"if True:\n",
			"def broken():\n    if True:\n",
			"try:\nfinally:\n",
		] {
			let code = format!("def previous(): return 1\n{tail}");
			let result = extract_python_symbols(&code, || Ok(())).unwrap();
			assert!(result.parse_error, "empty suite accepted: {tail:?}");
			assert!(result.symbols.is_empty(), "definitions leaked: {tail:?}");
		}
	}

	#[test]
	fn comments_before_a_statement_do_not_make_a_suite_empty() {
		let code = "def valid():\n    # comment\n    pass\n";
		let result = extract_python_symbols(code, || Ok(())).unwrap();
		assert!(!result.parse_error);
		assert_eq!(result.symbols.len(), 1);
		assert_eq!(result.symbols[0].name, "valid");
		assert_eq!(result.symbols[0].start_line, 1);
		assert_eq!(result.symbols[0].end_line, 3);
	}
}
