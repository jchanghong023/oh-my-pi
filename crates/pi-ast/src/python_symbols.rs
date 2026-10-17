//! Python definition extraction from the shared cached Tree-sitter parse.

use anyhow::Result;
use tree_sitter::{Node, Tree};

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
	let Some(mut tree) = tree else {
		return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
	};
	if tree.root_node().has_error() {
		let Some(compatible_tree) = parse_python36_function_names(code, &tree, &mut heartbeat)?
		else {
			return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
		};
		tree = compatible_tree;
	}
	let mut symbols = Vec::new();
	let mut qualification = String::new();
	if !visit(tree.root_node(), code, &mut qualification, &mut symbols, &mut heartbeat)? {
		return Ok(PythonSymbolsResult { parse_error: true, ..Default::default() });
	}
	heartbeat()?;
	Ok(PythonSymbolsResult { symbols, parse_error: false })
}

/// Only retry a failed modern parse when `async`/`await` occupies a function's
/// name slot. Equal-width replacements preserve every original source
/// coordinate.
fn parse_python36_function_names(
	code: &str,
	tree: &Tree,
	heartbeat: &mut impl FnMut() -> Result<()>,
) -> Result<Option<Tree>> {
	let mut rewritten: Option<String> = None;
	let mut names = Vec::new();
	let mut cursor = tree.walk();
	'walk: loop {
		heartbeat()?;
		let node = cursor.node();
		if node.kind() == "def" {
			let start = skip_declaration_whitespace(code, node.end_byte());
			let end = start.saturating_add(5);
			if matches!(code.get(start..end), Some("async" | "await"))
				&& code.as_bytes().get(skip_declaration_whitespace(code, end)) == Some(&b'(')
			{
				rewritten
					.get_or_insert_with(|| code.to_owned())
					.replace_range(end - 1..end, "_");
				names.push(start);
			}
		}
		if cursor.goto_first_child() {
			continue;
		}
		while !cursor.goto_next_sibling() {
			if !cursor.goto_parent() {
				break 'walk;
			}
		}
	}
	let Some(rewritten) = rewritten else {
		return Ok(None);
	};
	let Some(tree) = parse_cached(&rewritten, SupportLang::Python, None)? else {
		return Ok(None);
	};
	heartbeat()?;
	if tree.root_node().has_error() {
		return Ok(None);
	}
	// Error recovery can place tokens in unexpected contexts. Accept
	// replacements only after a complete parse proves they are synchronous
	// function names outside any async function's scope.
	for start in names {
		let Some(name) = tree.root_node().descendant_for_byte_range(start, start + 5) else {
			return Ok(None);
		};
		let Some(definition) = name.parent() else {
			return Ok(None);
		};
		if name.byte_range() != (start..start + 5)
			|| definition.kind() != "function_definition"
			|| definition.child_by_field_name("name") != Some(name)
		{
			return Ok(None);
		}
		let mut ancestor = Some(definition);
		while let Some(node) = ancestor {
			heartbeat()?;
			if node.kind() == "function_definition"
				&& node.child(0).is_some_and(|child| child.kind() == "async")
			{
				return Ok(None);
			}
			ancestor = node.parent();
		}
	}
	Ok(Some(tree))
}

fn skip_declaration_whitespace(code: &str, mut offset: usize) -> usize {
	let bytes = code.as_bytes();
	loop {
		match bytes.get(offset) {
			Some(b' ' | b'\t' | b'\x0c') => offset += 1,
			Some(b'\\') if bytes.get(offset + 1) == Some(&b'\n') => offset += 2,
			Some(b'\\') if bytes.get(offset + 1..offset + 3) == Some(b"\r\n") => offset += 3,
			_ => return offset,
		}
	}
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
	fn python36_soft_keyword_function_names_preserve_symbols_and_coordinates() {
		let lines = [
			"# 値: preserve original UTF-8 offsets",
			"def before(): return 1",
			"",
			"@decorate('await async')",
			"def async(",
			"    value='async await',",
			"):",
			"    return value",
			"",
			"def await(): return 'await async'",
			"def after(): return 2",
		];
		for newline in ["\n", "\r\n"] {
			let code = lines.join(newline);
			let result = extract_python_symbols(&code, || Ok(())).unwrap();
			assert!(!result.parse_error, "Python 3.6 names rejected: {newline:?}");
			let async_signature = lines[3..7].join(newline);
			assert_eq!(
				result
					.symbols
					.iter()
					.map(|symbol| (
						symbol.name.as_str(),
						symbol.qualname.as_str(),
						symbol.kind,
						symbol.start_line,
						symbol.end_line,
						symbol.signature.as_str(),
					))
					.collect::<Vec<_>>(),
				vec![
					("before", "before", "function", 2, 2, "def before():"),
					("async", "async", "function", 4, 8, async_signature.as_str()),
					("await", "await", "function", 10, 10, "def await():"),
					("after", "after", "function", 11, 11, "def after():"),
				],
				"names, signatures and coordinates must come from the original source",
			);
		}
	}

	#[test]
	fn python36_soft_keyword_names_coexist_with_async_await_syntax() {
		let code = concat!(
			"def async(): return 1\n",
			"def await(): return 2\n",
			"async def fetch(task):\n",
			"    value = await task\n",
			"    return value\n",
			"def after(): return 3\n",
		);
		let result = extract_python_symbols(code, || Ok(())).unwrap();
		assert!(!result.parse_error);
		assert_eq!(
			result
				.symbols
				.iter()
				.map(|symbol| (
					symbol.name.as_str(),
					symbol.start_line,
					symbol.end_line,
					symbol.signature.as_str(),
				))
				.collect::<Vec<_>>(),
			vec![
				("async", 1, 1, "def async():"),
				("await", 2, 2, "def await():"),
				("fetch", 3, 5, "async def fetch(task):"),
				("after", 6, 6, "def after():"),
			],
		);
	}

	#[test]
	fn python36_soft_keyword_names_do_not_hide_syntax_errors() {
		for tail in [
			"def await(: pass\n",
			"async def async(): pass\n",
			"async def await(): pass\n",
			"async def outer():\n    def async(): pass\n",
			"async def outer():\n    def await(): pass\n",
			"async def broken(:\n    await task\n",
			"async def broken():\n    await (\n",
			"async def broken():\n    async for item in :\n        pass\n",
			"def broken():\n    # comment\n",
		] {
			let code = format!("def before(): return 1\ndef async(): pass\ndef await(): pass\n{tail}");
			let result = extract_python_symbols(&code, || Ok(())).unwrap();
			assert!(result.parse_error, "invalid syntax accepted: {tail:?}");
			assert!(result.symbols.is_empty(), "definitions leaked: {tail:?}");
		}
	}

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
