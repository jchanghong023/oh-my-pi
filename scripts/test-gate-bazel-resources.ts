import { existsSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packageCommandKind, packageScriptInputs } from "./test-gate-bazel-script-inputs";
import { ts } from "@ts-morph/common";

export interface GateResources {
	files: string[];
	entries: string[];
	fallback: boolean;
	repositoryFallback: boolean;
}
const fileDataCalls = new Set(["file", "readFile", "readFileSync", "createReadStream", "open", "openSync"]);
const processDataCalls = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
const bunDataCalls = new Set(["file", "spawn", "spawnSync"]);

/** Supplement Bun's module graph with module-relative assets and subprocess entries.
 * Unknown module-relative expressions retain their package boundary. Runtime user
 * paths and test-created temporary files are not repository source inputs. */
export function gateResources(
	filename: string,
	text: string,
	inventory: ReadonlySet<string>,
	root: string,
	onResourcePath?: (absolute: string) => void,
): GateResources {
	// Resource consumers need call arguments. Parentheses cannot be escaped in
	// JavaScript syntax; comments/strings may only produce false positives here.
	// In particular, data-only modules do not need a TypeScript AST at all.
	if (!text.includes("(")) return { files: [], entries: [], fallback: false, repositoryFallback: false };
	// All expressions anchored to this module ultimately contain one of these
	// tokens. Keep comments/whitespace between import and "." and escaped
	// identifiers conservative. Ordinary imports do not make every argument in
	// a large module worth recursively traversing for an anchor.
	const mayHaveAnchor = /__dirname|__filename|\bimport\s*[./]|\\u/.test(text);
	const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, false);
	const directory = path.dirname(filename);
	const files = new Set<string>();
	const entries = new Set<string>();
	const constants = new Map<string, ts.Expression | undefined>();
	const paths = new Map<string, string>();
	const namespaces = new Set<string>();
	const assertions = new Set<string>();
	const requireFactories = new Set<string>();
	const requireNamespaces = new Set<string>();
	const globFactories = new Set<string>();
	const globNamespaces = new Set<string>();
	const shellTags = new Set<string>();
	const temporaryDirectoryFunctions = new Set<string>();
	const osNamespaces = new Set<string>();
	const temporaryFactories = new Set<string>();
	const temporaryNamespaces = new Set<string>();
	const dataFunctions = new Set<string>();
	const dataNamespaces = new Map<string, ReadonlySet<string>>();
	const parents = new Map<ts.Node, ts.Node>();
	const scopedConstants = new Map<ts.Node, Map<string, ts.Expression | undefined>>();
	const destructuredValues = new Map<ts.Node, Map<string, { object: ts.Expression; property: string }>>();
	const assignedNames = new Set<string>();
	const fixtureFunctions = new Map<string, ts.FunctionDeclaration | undefined>();
	const loopValues = new Map<ts.Node, ts.Expression>();
	const structuredFunctions = new Map<string, ts.FunctionDeclaration | undefined>();
	// Literal arguments usually are not filenames. Enumerate each candidate
	// directory once instead of issuing a failed stat for every distinct string.
	// All reuse ends with this source scan.
	const installedPaths = new Map<string, Stats | undefined>();
	const installedDirectories = new Map<string, Set<string> | undefined>();
	const installedPath = (absolute: string): Stats | undefined => {
		if (!installedPaths.has(absolute)) {
			const parent = path.dirname(absolute);
			if (!installedDirectories.has(parent)) {
				try {
					// Folding only rejects names impossible even on case-insensitive
					// filesystems; a possible match still uses the real filesystem.
					const names = readdirSync(parent);
					installedDirectories.set(
						parent,
						names.some(name => /[^\x00-\x7f]/.test(name))
							? undefined
							: new Set(names.map(name => name.toLowerCase())),
					);
				} catch {
					// Preserve the stat behavior when enumeration is unavailable.
					installedDirectories.set(parent, undefined);
				}
			}
			const names = installedDirectories.get(parent);
			const basename = path.basename(absolute);
			installedPaths.set(
				absolute,
				names &&
					/^[\x00-\x7f]*$/.test(basename) &&
					!/[~:]|[. ]$/.test(basename) &&
					!names.has(basename.toLowerCase())
					? undefined
					: existsSync(absolute)
						? statSync(absolute)
						: undefined,
			);
		}
		return installedPaths.get(absolute);
	};
	const calls: (ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression)[] = [];
	let fallback = false;
	let repositoryFallback = false;
	const visit = (node: ts.Node, parent?: ts.Node) => {
		if (parent) parents.set(node, parent);
		collect(node, parent);
		ts.forEachChild(node, child => visit(child, node));
	};
	const bind = (name: ts.BindingName, constant: boolean, initializer?: ts.Expression, scope?: ts.Node) => {
		if (ts.isIdentifier(name)) {
			const duplicate = constants.has(name.text);
			constants.set(name.text, duplicate || !constant ? undefined : initializer);
			if (scope) {
				let declarations = scopedConstants.get(scope);
				if (!declarations) scopedConstants.set(scope, (declarations = new Map()));
				declarations.set(name.text, declarations.has(name.text) || !constant ? undefined : initializer);
			}
			return;
		}
		for (const element of name.elements) {
			if (ts.isOmittedExpression(element)) continue;
			const property = element.propertyName ?? element.name;
			bind(element.name, constant, undefined, scope);
			if (
				scope &&
				constant &&
				initializer &&
				ts.isObjectBindingPattern(name) &&
				ts.isIdentifier(element.name) &&
				!element.dotDotDotToken &&
				!element.initializer &&
				(ts.isIdentifier(property) || ts.isStringLiteral(property))
			) {
				let values = destructuredValues.get(scope);
				if (!values) destructuredValues.set(scope, (values = new Map()));
				if (values.has(element.name.text)) values.delete(element.name.text);
				else values.set(element.name.text, { object: initializer, property: property.text });
			}
		}
	};
	// A plan wrapper may forward paths in fields, but a helper that computes
	// new paths must keep the opaque-loading boundary.
	const forwardsStructure = (node: ts.Node): boolean => {
		if (
			ts.isBinaryExpression(node) ||
			ts.isTemplateExpression(node) ||
			ts.isTaggedTemplateExpression(node) ||
			ts.isNewExpression(node)
		)
			return false;
		if (
			ts.isCallExpression(node) &&
			!(
				ts.isPropertyAccessExpression(node.expression) &&
				ts.isIdentifier(node.expression.expression) &&
				node.expression.expression.text === "JSON" &&
				node.expression.name.text === "stringify"
			)
		)
			return false;
		let forwarded = true;
		ts.forEachChild(node, child => {
			if (!forwardsStructure(child)) forwarded = false;
		});
		return forwarded;
	};
	const collect = (node: ts.Node, parent?: ts.Node) => {
		if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node))
			calls.push(node);
		if (
			ts.isBinaryExpression(node) &&
			node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
			node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
			ts.isIdentifier(node.left)
		)
			assignedNames.add(node.left.text);
		if (
			(ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
			(node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
			ts.isIdentifier(node.operand)
		)
			assignedNames.add(node.operand.text);
		if (ts.isFunctionDeclaration(node) && node.name && node.body) {
			fixtureFunctions.set(node.name.text, fixtureFunctions.has(node.name.text) ? undefined : node);
			const statement = node.body.statements.length === 1 ? node.body.statements[0] : undefined;
			const structured =
				!!statement &&
				ts.isReturnStatement(statement) &&
				!!statement.expression &&
				ts.isObjectLiteralExpression(statement.expression) &&
				forwardsStructure(statement.expression);
			structuredFunctions.set(
				node.name.text,
				structured && (!structuredFunctions.has(node.name.text) || structuredFunctions.get(node.name.text))
					? node
					: undefined,
			);
		}
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const module = node.moduleSpecifier.text.replace(/^node:/, "");
			const dataCalls =
				module === "fs" || module === "fs/promises"
					? fileDataCalls
					: module === "child_process"
						? processDataCalls
						: module === "bun"
							? bunDataCalls
							: undefined;
			if (module === "fs" || module === "fs/promises") {
				const bindings = node.importClause?.namedBindings;
				if (node.importClause?.name) temporaryNamespaces.add(node.importClause.name.text);
				if (bindings && ts.isNamespaceImport(bindings)) temporaryNamespaces.add(bindings.name.text);
				if (bindings && ts.isNamedImports(bindings))
					for (const binding of bindings.elements)
						if (["mkdtemp", "mkdtempSync"].includes((binding.propertyName ?? binding.name).text))
							temporaryFactories.add(binding.name.text);
			}
			if (dataCalls) {
				const bindings = node.importClause?.namedBindings;
				if (node.importClause?.name) dataNamespaces.set(node.importClause.name.text, dataCalls);
				if (bindings && ts.isNamespaceImport(bindings)) dataNamespaces.set(bindings.name.text, dataCalls);
				if (bindings && ts.isNamedImports(bindings))
					for (const element of bindings.elements)
						if (dataCalls.has((element.propertyName ?? element.name).text)) dataFunctions.add(element.name.text);
			}
			if (module === "bun:test" || module === "assert" || module === "assert/strict") {
				const bindings = node.importClause?.namedBindings;
				if (node.importClause?.name) assertions.add(node.importClause.name.text);
				if (bindings && ts.isNamedImports(bindings))
					for (const element of bindings.elements) assertions.add(element.name.text);
			}
			if (module === "bun") {
				const bindings = node.importClause?.namedBindings;
				if (bindings && ts.isNamespaceImport(bindings)) globNamespaces.add(bindings.name.text);
				if (bindings && ts.isNamedImports(bindings))
					for (const binding of bindings.elements) {
						const name = (binding.propertyName ?? binding.name).text;
						if (name === "Glob") globFactories.add(binding.name.text);
						if (name === "$") shellTags.add(binding.name.text);
					}
			}
			if (module === "os") {
				const bindings = node.importClause?.namedBindings;
				if (node.importClause?.name) osNamespaces.add(node.importClause.name.text);
				if (bindings && ts.isNamespaceImport(bindings)) osNamespaces.add(bindings.name.text);
				if (bindings && ts.isNamedImports(bindings))
					for (const binding of bindings.elements)
						if ((binding.propertyName ?? binding.name).text === "tmpdir")
							temporaryDirectoryFunctions.add(binding.name.text);
			}
			if (module === "module") {
				const bindings = node.importClause?.namedBindings;
				if (node.importClause?.name) requireNamespaces.add(node.importClause.name.text);
				if (bindings && ts.isNamespaceImport(bindings)) requireNamespaces.add(bindings.name.text);
				if (bindings && ts.isNamedImports(bindings))
					for (const binding of bindings.elements)
						if ((binding.propertyName ?? binding.name).text === "createRequire")
							requireFactories.add(binding.name.text);
			}
			if (module !== "path" && module !== "url") return;
			const bindings = node.importClause?.namedBindings;
			if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
			if (node.importClause?.name) namespaces.add(node.importClause.name.text);
			if (bindings && ts.isNamedImports(bindings))
				for (const element of bindings.elements)
					paths.set(element.name.text, (element.propertyName ?? element.name).text);
		}
		if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
			const constant =
				ts.isVariableDeclaration(node) &&
				parent !== undefined &&
				ts.isVariableDeclarationList(parent) &&
				(parent.flags & ts.NodeFlags.Const) !== 0;
			let scope = parent;
			while (
				scope &&
				!ts.isSourceFile(scope) &&
				!ts.isBlock(scope) &&
				!ts.isFunctionLike(scope) &&
				!ts.isForOfStatement(scope)
			)
				scope = parents.get(scope);
			bind(node.name, constant, node.initializer, scope);
		}
	};
	visit(source);
	const initializer = (node: ts.Identifier): ts.Expression | undefined => {
		for (let scope = parents.get(node); scope; scope = parents.get(scope)) {
			const declarations = scopedConstants.get(scope);
			if (!declarations?.has(node.text)) continue;
			if (loopValues.has(scope)) return loopValues.get(scope);
			return declarations.get(node.text);
		}
		return undefined;
	};
	const shellTag = (tag: ts.Expression): boolean =>
		(ts.isIdentifier(tag) && !constants.has(tag.text) && shellTags.has(tag.text)) ||
		(ts.isPropertyAccessExpression(tag) &&
			ts.isIdentifier(tag.expression) &&
			!constants.has(tag.expression.text) &&
			tag.name.text === "$" &&
			(tag.expression.text === "Bun" || dataNamespaces.get(tag.expression.text) === bunDataCalls));
	const hasScopedBinding = (node: ts.Identifier): boolean => {
		for (let scope = parents.get(node); scope; scope = parents.get(scope))
			if (scopedConstants.get(scope)?.has(node.text)) return true;
		return false;
	};
	// Resolve roles only after every binding is collected: aliases can precede
	// declarations, and duplicate/parameter bindings must invalidate imports.
	// Module namespaces, createRequire factories/loaders and CommonJS Module
	// instances propagate roles; ordinary data/function aliases stay unrelated.
	type RequireRole = "namespace" | "factory" | "loader" | "module";
	const requireRole = (node: ts.Expression, seen = new Set<ts.Node>()): RequireRole | undefined => {
		if (seen.has(node)) return undefined;
		seen.add(node);
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
			return requireRole(node.expression, seen);
		if (ts.isIdentifier(node)) {
			for (let scope = parents.get(node); scope; scope = parents.get(scope)) {
				const declarations = scopedConstants.get(scope);
				if (!declarations?.has(node.text)) continue;
				const destructured = destructuredValues.get(scope)?.get(node.text);
				if (destructured?.property === "createRequire" && requireRole(destructured.object, seen) === "namespace")
					return "factory";
				const expression = declarations.get(node.text);
				return expression ? requireRole(expression, seen) : undefined;
			}
			return requireFactories.has(node.text)
				? "factory"
				: requireNamespaces.has(node.text)
					? "namespace"
					: node.text === "module"
						? "module"
						: undefined;
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			node.name.text === "createRequire" &&
			requireRole(node.expression, seen) === "namespace"
		)
			return "factory";
		if (ts.isCallExpression(node)) {
			if (
				ts.isIdentifier(node.expression) &&
				node.expression.text === "require" &&
				!hasScopedBinding(node.expression) &&
				node.arguments.length === 1 &&
				ts.isStringLiteralLike(node.arguments[0]) &&
				/^(?:node:)?module$/.test(node.arguments[0].text)
			)
				return "namespace";
			if (requireRole(node.expression, seen) === "factory") return "loader";
		}
		return undefined;
	};
	// Resolve only transparent object forwarding, never file contents or JSON
	// strings. Keep the original expressions so cwd and argv retain their scope.
	const structuredProperty = (
		node: ts.Expression,
		name: string,
		seen = new Set<ts.Expression>(),
	): ts.Expression | undefined => {
		if (seen.has(node)) return undefined;
		seen.add(node);
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
			return structuredProperty(node.expression, name, seen);
		if (ts.isIdentifier(node)) {
			const expression = initializer(node);
			return expression ? structuredProperty(expression, name, seen) : undefined;
		}
		if (ts.isObjectLiteralExpression(node)) {
			for (const property of node.properties) {
				if (ts.isPropertyAssignment(property) && property.name.getText(source) === name)
					return property.initializer;
				if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
			}
			return undefined;
		}
		if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || constants.has(node.expression.text))
			return undefined;
		const declaration = structuredFunctions.get(node.expression.text);
		const statement = declaration?.body?.statements[0];
		if (!declaration || !statement || !ts.isReturnStatement(statement) || !statement.expression) return undefined;
		const expression = structuredProperty(statement.expression, name, seen);
		if (!expression) return undefined;
		const parameter = declaration.parameters[0]?.name;
		if (
			declaration.parameters.length === 1 &&
			parameter &&
			ts.isIdentifier(parameter) &&
			ts.isPropertyAccessExpression(expression) &&
			ts.isIdentifier(expression.expression) &&
			expression.expression.text === parameter.text
		) {
			const argument = node.arguments[0];
			return argument ? structuredProperty(argument, expression.name.text, seen) : undefined;
		}
		return expression;
	};
	const value = (node: ts.Expression, seen = new Set<string>()): string | undefined => {
		if (ts.isStringLiteralLike(node)) return node.text;
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
			return value(node.expression, seen);
		if (ts.isIdentifier(node)) {
			if (node.text === "__dirname") return directory;
			if (node.text === "__filename") return filename;
			if (seen.has(node.text)) return undefined;
			const expression = initializer(node);
			return expression ? value(expression, new Set([...seen, node.text])) : undefined;
		}
		if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
			if (node.name.text === "dir") return directory;
			if (node.name.text === "url") return pathToFileURL(filename).href;
			if (node.name.text === "path") return filename;
		}
		if (ts.isPropertyAccessExpression(node) && node.name.text === "href") return value(node.expression, seen);
		if (
			ts.isPropertyAccessExpression(node) &&
			ts.isIdentifier(node.expression) &&
			node.expression.text === "process" &&
			!constants.has("process")
		) {
			if (node.name.text === "platform") return process.platform;
			if (node.name.text === "arch") return process.arch;
			if (node.name.text === "execPath") return process.execPath;
		}
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const left = value(node.left, seen),
				right = value(node.right, seen);
			return left !== undefined && right !== undefined ? left + right : undefined;
		}
		if (ts.isTemplateExpression(node)) {
			let result = node.head.text;
			for (const span of node.templateSpans) {
				const part = value(span.expression, seen);
				if (part === undefined) return undefined;
				result += part + span.literal.text;
			}
			return result;
		}
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
			const args = (node.arguments ?? []).map(argument => value(argument, seen));
			if (args[0] !== undefined && (args.length === 1 || args[1] !== undefined)) {
				try {
					return new URL(args[0], args[1]).href;
				} catch {
					return undefined;
				}
			}
		}
		if (ts.isCallExpression(node)) {
			const call = node.expression;
			const name = ts.isIdentifier(call)
				? paths.get(call.text)
				: ts.isPropertyAccessExpression(call) &&
					  ts.isIdentifier(call.expression) &&
					  namespaces.has(call.expression.text)
					? call.name.text
					: undefined;
			if (!name) return undefined;
			const args = node.arguments.map(argument => value(argument, seen));
			if (args.some(argument => argument === undefined)) return undefined;
			const strings = args as string[];
			if (name === "join") return path.join(...strings);
			if (name === "resolve" && strings.some(argument => path.isAbsolute(argument))) return path.resolve(...strings);
			if (name === "dirname" && strings[0]) return path.dirname(strings[0]);
			if (name === "relative" && strings.length === 2) return path.relative(strings[0]!, strings[1]!);
			if (name === "fileURLToPath" && strings[0]?.startsWith("file:")) return fileURLToPath(strings[0]);
			if (name === "pathToFileURL" && strings[0]) return pathToFileURL(strings[0]).href;
		}
		return undefined;
	};
	// A fixture's individual returned property is temporary only if every
	// return proves that property; arbitrary function results are not paths.
	const runtimeTemporaryDirectory = (node: ts.Expression, seen = new Set<ts.Node>()): boolean => {
		if (seen.has(node)) return false;
		seen.add(node);
		if (
			ts.isParenthesizedExpression(node) ||
			ts.isAsExpression(node) ||
			ts.isNonNullExpression(node) ||
			ts.isAwaitExpression(node)
		)
			return runtimeTemporaryDirectory(node.expression, seen);
		if (ts.isIdentifier(node)) {
			if (assignedNames.has(node.text)) return false;
			for (let scope = parents.get(node); scope; scope = parents.get(scope)) {
				if (!scopedConstants.get(scope)?.has(node.text)) continue;
				const binding = destructuredValues.get(scope)?.get(node.text);
				if (binding) return temporaryProperty(binding.object, binding.property, seen);
				const expression = scopedConstants.get(scope)?.get(node.text);
				return !!expression && runtimeTemporaryDirectory(expression, seen);
			}
			return false;
		}
		if (ts.isPropertyAccessExpression(node)) return temporaryProperty(node.expression, node.name.text, seen);
		if (!ts.isCallExpression(node)) return false;
		const call = node.expression;
		if (
			node.arguments.length === 0 &&
			(ts.isIdentifier(call)
				? !hasScopedBinding(call) && temporaryDirectoryFunctions.has(call.text)
				: ts.isPropertyAccessExpression(call) &&
					ts.isIdentifier(call.expression) &&
					!hasScopedBinding(call.expression) &&
					osNamespaces.has(call.expression.text) &&
					call.name.text === "tmpdir")
		)
			return true;
		const factory = ts.isIdentifier(call)
			? !hasScopedBinding(call) && temporaryFactories.has(call.text)
			: ts.isPropertyAccessExpression(call) &&
				ts.isIdentifier(call.expression) &&
				!hasScopedBinding(call.expression) &&
				temporaryNamespaces.has(call.expression.text) &&
				["mkdtemp", "mkdtempSync"].includes(call.name.text);
		if (factory) return node.arguments.length === 1 && runtimeTemporaryDirectory(node.arguments[0]!, seen);
		const name = ts.isIdentifier(call)
			? !hasScopedBinding(call)
				? paths.get(call.text)
				: undefined
			: ts.isPropertyAccessExpression(call) &&
				  ts.isIdentifier(call.expression) &&
				  !hasScopedBinding(call.expression) &&
				  namespaces.has(call.expression.text)
				? call.name.text
				: undefined;
		if (name !== "join" || node.arguments.length === 0 || !runtimeTemporaryDirectory(node.arguments[0]!, seen))
			return false;
		return node.arguments.slice(1).every(argument => {
			const part = value(argument);
			return part !== undefined && !path.isAbsolute(part) && !part.split(/[\\/]/).includes("..");
		});
	};
	const temporaryProperty = (node: ts.Expression, property: string, seen: Set<ts.Node>): boolean => {
		if (seen.has(node)) return false;
		seen.add(node);
		if (ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
			return temporaryProperty(node.expression, property, seen);
		if (ts.isIdentifier(node)) {
			if (assignedNames.has(node.text)) return false;
			const expression = initializer(node);
			return !!expression && temporaryProperty(expression, property, seen);
		}
		if (ts.isObjectLiteralExpression(node)) {
			if (node.properties.some(item => ts.isSpreadAssignment(item))) return false;
			const matches = node.properties.filter(
				item =>
					(ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
					(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
					item.name.text === property,
			);
			if (matches.length !== 1) return false;
			const item = matches[0]!;
			return ts.isPropertyAssignment(item)
				? runtimeTemporaryDirectory(item.initializer, seen)
				: ts.isShorthandPropertyAssignment(item) && runtimeTemporaryDirectory(item.name, seen);
		}
		if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || hasScopedBinding(node.expression))
			return false;
		const declaration = fixtureFunctions.get(node.expression.text);
		if (!declaration?.body) return false;
		const returns: ts.ReturnStatement[] = [];
		const collectReturns = (child: ts.Node): void => {
			if (child !== declaration.body && ts.isFunctionLike(child)) return;
			if (ts.isReturnStatement(child)) returns.push(child);
			ts.forEachChild(child, collectReturns);
		};
		collectReturns(declaration.body);
		return (
			returns.length > 0 &&
			returns.every(item => !!item.expression && temporaryProperty(item.expression, property, new Set(seen)))
		);
	};
	const anchored = (node: ts.Node, seen = new Set<string>()): boolean => {
		if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false;
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Worker")
			return false;
		if (!mayHaveAnchor) return false;
		if (ts.isMetaProperty(node) || (ts.isIdentifier(node) && /^(?:__dirname|__filename)$/.test(node.text)))
			return true;
		if (ts.isTaggedTemplateExpression(node) && shellTag(node.tag)) return false;
		if (ts.isPropertyAccessExpression(node)) return anchored(node.expression, seen);
		if (ts.isCallExpression(node)) {
			const call = node.expression;
			if (
				ts.isIdentifier(call) &&
				!constants.has(call.text) &&
				/^(?:setTimeout|setInterval|setImmediate)$/.test(call.text)
			)
				return false;
			if (ts.isIdentifier(call) && !seen.has(call.text)) {
				const expression = initializer(call);
				if (
					expression &&
					(ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) &&
					anchored(expression.body, new Set([...seen, call.text]))
				)
					return true;
			}
			let root: ts.Expression = call;
			while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root)) root = root.expression;
			if (ts.isTaggedTemplateExpression(root) && shellTag(root.tag)) return false;
			if (
				ts.isIdentifier(call) &&
				!constants.has(call.text) &&
				!constants.has("JSON") &&
				structuredFunctions.get(call.text)
			)
				return false;
			if (
				ts.isPropertyAccessExpression(call) &&
				ts.isIdentifier(call.expression) &&
				call.expression.text === "JSON" &&
				!constants.has("JSON") &&
				call.name.text === "stringify"
			)
				return false;
			// I/O results are contents, handles or processes, not paths. Their
			// input arguments are scanned separately; propagating those anchors
			// into parse(fileContents) or forward(child.stdout) widens the graph.
			if (ts.isIdentifier(call) && !constants.has(call.text) && dataFunctions.has(call.text)) return false;
			if (
				ts.isPropertyAccessExpression(call) &&
				ts.isIdentifier(call.expression) &&
				!constants.has(call.expression.text) &&
				((call.expression.text === "Bun" && bunDataCalls.has(call.name.text)) ||
					dataNamespaces.get(call.expression.text)?.has(call.name.text))
			)
				return false;
			const name = ts.isIdentifier(call)
				? paths.get(call.text)
				: ts.isPropertyAccessExpression(call) &&
					  ts.isIdentifier(call.expression) &&
					  namespaces.has(call.expression.text)
					? call.name.text
					: undefined;
			// The base of relative(base, runtimePath) is not the file being read.
			if (name === "relative") return !!node.arguments[1] && anchored(node.arguments[1], seen);
		}
		if (ts.isIdentifier(node) && !seen.has(node.text)) {
			const expression = initializer(node);
			if (expression && anchored(expression, new Set([...seen, node.text]))) return true;
		}
		let result = false;
		ts.forEachChild(node, child => {
			if (anchored(child, seen)) result = true;
		});
		return result;
	};
	const globPattern = (node: ts.Expression, seen = new Set<string>()): string | undefined => {
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
			return globPattern(node.expression, seen);
		if (ts.isIdentifier(node)) {
			if (seen.has(node.text)) return undefined;
			const initializer = constants.get(node.text);
			return initializer ? globPattern(initializer, new Set([...seen, node.text])) : undefined;
		}
		if (!ts.isNewExpression(node)) return undefined;
		const factory = node.expression;
		const known = ts.isIdentifier(factory)
			? !constants.has(factory.text) && globFactories.has(factory.text)
			: ts.isPropertyAccessExpression(factory) &&
				factory.name.text === "Glob" &&
				ts.isIdentifier(factory.expression) &&
				!constants.has(factory.expression.text) &&
				(globNamespaces.has(factory.expression.text) || factory.expression.text === "Bun");
		return known && node.arguments?.[0] ? value(node.arguments[0]) : undefined;
	};
	// Gate-owned repositories, profiles and action outputs cannot become their
	// own discovery inputs, including when reached through a directory junction.
	const outputRoot = path.resolve(root, "node_modules/.cache/test-gate-bazel");
	const identity = (absolute: string): string => (process.platform === "win32" ? absolute.toLowerCase() : absolute);
	const outputRoots = [
		identity(outputRoot),
		identity(path.join(existsSync(root) ? realpathSync(root) : root, "node_modules/.cache/test-gate-bazel")),
	];
	const outputPath = (absolute: string): boolean => {
		const normalized = identity(absolute);
		return outputRoots.some(output => normalized === output || normalized.startsWith(output + path.sep));
	};
	const wrapperOutputRoot = identity(path.resolve(root, "node_modules/.cache/omp-gate-wrappers"));
	const producedNodes = new Set<ts.Expression>();
	const dereference = (node: ts.Expression, seen = new Set<ts.Expression>()): ts.Expression => {
		if (seen.has(node)) return node;
		seen.add(node);
		if (ts.isIdentifier(node)) {
			const expression = initializer(node);
			if (expression) return dereference(expression, seen);
		}
		return node;
	};
	for (const node of calls) {
		if (ts.isTaggedTemplateExpression(node)) continue;
		const call = node.expression;
		const name = ts.isIdentifier(call) ? call.text : ts.isPropertyAccessExpression(call) ? call.name.text : "";
		const target = /^(?:writeFile|writeFileSync|mkdir|mkdirSync)$/.test(name)
			? node.arguments?.[0]
			: /^(?:rename|renameSync|link|linkSync|copyFile|copyFileSync)$/.test(name)
				? node.arguments?.[1]
				: undefined;
		if (target) producedNodes.add(dereference(target));
		if (/^(?:spawn|spawnSync)$/.test(name))
			for (const argument of node.arguments ?? [])
				if (ts.isArrayLiteralExpression(argument))
					for (let index = 0; index + 1 < argument.elements.length; index++) {
						const flag = argument.elements[index]!;
						if (ts.isStringLiteralLike(flag) && flag.text === "-o")
							producedNodes.add(dereference(argument.elements[index + 1]! as ts.Expression));
					}
	}
	// Only provably contained generated paths may bypass an opaque boundary.
	// UUIDs cannot add a separator or ".."; arbitrary dynamic suffixes can.
	const uuidFactories = new Set<string>();
	for (const statement of source.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
		if (!/^(?:node:)?crypto$/.test(statement.moduleSpecifier.text)) continue;
		const bindings = statement.importClause?.namedBindings;
		if (bindings && ts.isNamedImports(bindings))
			for (const binding of bindings.elements)
				if ((binding.propertyName ?? binding.name).text === "randomUUID") uuidFactories.add(binding.name.text);
	}
	const safeComponent = (node: ts.Expression): boolean => {
		const literal = value(node);
		if (literal !== undefined) return !/[\\/]/.test(literal) && literal !== "..";
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
			return uuidFactories.has(node.expression.text) && !constants.has(node.expression.text);
		if (ts.isTemplateExpression(node))
			return (
				!/[\\/]/.test(node.head.text) &&
				node.templateSpans.every(span => !/[\\/]/.test(span.literal.text) && safeComponent(span.expression)) &&
				node.head.text !== ".."
			);
		return false;
	};
	const containedGeneratedPath = (node: ts.Expression, seen = new Set<string>()): boolean => {
		const literal = value(node);
		if (literal !== undefined) {
			const absolute = identity(path.resolve(literal));
			return (
				path.isAbsolute(literal) &&
				(absolute === wrapperOutputRoot || absolute.startsWith(wrapperOutputRoot + path.sep))
			);
		}
		if (ts.isIdentifier(node) && !seen.has(node.text)) {
			const expression = initializer(node);
			return !!expression && containedGeneratedPath(expression, new Set([...seen, node.text]));
		}
		if (ts.isTemplateExpression(node) && node.head.text === "" && node.templateSpans.length > 0) {
			const [first, ...rest] = node.templateSpans;
			return (
				containedGeneratedPath(first!.expression, seen) &&
				first!.literal.text.startsWith(".") &&
				!/[\\/]/.test(first!.literal.text) &&
				rest.every(span => safeComponent(span.expression) && !/[\\/]/.test(span.literal.text))
			);
		}
		if (!ts.isCallExpression(node) || node.arguments.length === 0) return false;
		const call = node.expression;
		const name = ts.isIdentifier(call)
			? paths.get(call.text)
			: ts.isPropertyAccessExpression(call) &&
				  ts.isIdentifier(call.expression) &&
				  namespaces.has(call.expression.text)
				? call.name.text
				: undefined;
		return (
			(name === "join" || name === "resolve") &&
			containedGeneratedPath(node.arguments[0]!, seen) &&
			node.arguments.slice(1).every(safeComponent)
		);
	};
	const generatedPath = (node: ts.Expression): boolean =>
		producedNodes.has(dereference(node)) && containedGeneratedPath(node);
	// A quoted argv formatter changes representation, not the tool paths.
	// Accept only literal quote wrappers; arbitrary mappers remain opaque.
	const formattedWords = (
		node: ts.Expression,
		seen = new Set<ts.Expression>(),
	): readonly ts.Expression[] | undefined => {
		node = dereference(node);
		if (seen.has(node)) return undefined;
		seen.add(node);
		if (
			ts.isTemplateExpression(node) &&
			/^--?[\w-]+=$/.test(node.head.text) &&
			node.templateSpans.length === 1 &&
			node.templateSpans[0]!.literal.text === ""
		)
			return formattedWords(node.templateSpans[0]!.expression, seen);
		if (
			!ts.isCallExpression(node) ||
			!ts.isPropertyAccessExpression(node.expression) ||
			node.expression.name.text !== "join" ||
			node.arguments.length !== 1 ||
			value(node.arguments[0]!) !== " "
		)
			return undefined;
		const map = node.expression.expression;
		if (
			!ts.isCallExpression(map) ||
			!ts.isPropertyAccessExpression(map.expression) ||
			map.expression.name.text !== "map" ||
			!ts.isArrayLiteralExpression(map.expression.expression) ||
			map.arguments.length !== 1
		)
			return undefined;
		const mapper = map.arguments[0]!;
		if (!ts.isArrowFunction(mapper) || mapper.parameters.length !== 1 || !ts.isIdentifier(mapper.parameters[0]!.name))
			return undefined;
		const parameter = mapper.parameters[0]!.name.text;
		const quoteCondition = (expression: ts.Expression): boolean => {
			if (
				ts.isBinaryExpression(expression) &&
				expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
			)
				return quoteCondition(expression.left) && quoteCondition(expression.right);
			return (
				ts.isCallExpression(expression) &&
				ts.isPropertyAccessExpression(expression.expression) &&
				ts.isIdentifier(expression.expression.expression) &&
				expression.expression.expression.text === parameter &&
				expression.expression.name.text === "includes" &&
				expression.arguments.length === 1 &&
				["'", '"'].includes(value(expression.arguments[0]!) ?? "")
			);
		};
		const quoted = (expression: ts.Expression): boolean => {
			if (ts.isIdentifier(expression)) return expression.text === parameter;
			if (ts.isConditionalExpression(expression))
				return quoteCondition(expression.condition) && quoted(expression.whenTrue) && quoted(expression.whenFalse);
			if (
				!ts.isTemplateExpression(expression) ||
				!["'", '"'].includes(expression.head.text) ||
				expression.templateSpans.length !== 1
			)
				return false;
			const span = expression.templateSpans[0]!;
			return (
				span.literal.text === expression.head.text &&
				ts.isIdentifier(span.expression) &&
				span.expression.text === parameter
			);
		};
		let result: ts.Expression | undefined;
		if (ts.isBlock(mapper.body)) {
			const statements = mapper.body.statements;
			const last = statements.at(-1);
			if (!last || !ts.isReturnStatement(last)) return undefined;
			if (
				!statements
					.slice(0, -1)
					.every(
						statement =>
							ts.isIfStatement(statement) &&
							quoteCondition(statement.expression) &&
							ts.isThrowStatement(statement.thenStatement) &&
							!statement.elseStatement,
					)
			)
				return undefined;
			result = last.expression;
		} else result = mapper.body;
		return result && quoted(result) ? map.expression.expression.elements.filter(ts.isExpression) : undefined;
	};
	// Win32 lookup aliases trailing dots/spaces, whereas Bazel's Java path
	// parser rejects trailing spaces. Canonicalize before containment, inventory,
	// stat and watch registration so all four describe the same resource.
	const resourcePath = (candidate: string): string | undefined => {
		if (process.platform !== "win32") return candidate;
		const components = candidate.split(/[\\/]/);
		for (let index = 0; index < components.length; index++) {
			const component = components[index]!;
			if (!component || component === "." || component === "..") continue;
			const normalized = component.replace(/[. ]+$/, "");
			if (!normalized) return undefined;
			components[index] = normalized;
		}
		return components.join(path.sep);
	};
	const add = (candidate: string, directoryInput: boolean, entry: boolean, cwd?: string, pattern?: string) => {
		// Calls also carry ordinary data literals. NUL cannot name a filesystem
		// resource on any supported platform, so never probe it as a path.
		if (candidate.includes("\0")) return;
		if (candidate.startsWith("file:")) {
			try {
				candidate = fileURLToPath(candidate);
			} catch {
				return;
			} // Test data may contain URLs invalid on the current platform.
		}
		const normalized = resourcePath(candidate);
		if (normalized === undefined) return;
		candidate = normalized;
		const candidates = path.isAbsolute(candidate)
			? [path.resolve(candidate)]
			: [
					path.resolve(directory, candidate),
					path.resolve(root, candidate),
					...(cwd ? [path.resolve(cwd, candidate)] : []),
				];
		for (const candidatePath of candidates) {
			const absolute = resourcePath(candidatePath);
			if (absolute === undefined) continue;
			const relative = path.relative(root, absolute).replaceAll("\\", "/");
			if (relative.startsWith("../") || path.isAbsolute(relative)) continue;
			// Ordinary data literals can contain characters that Windows cannot
			// represent in a filename; they are not native watchable paths either.
			if (process.platform === "win32" && /[<>:"|?*\x00-\x1f]/.test(relative)) continue;
			if (outputPath(absolute)) continue;
			const inventoried = inventory.has(relative);
			const status = inventoried ? undefined : installedPath(absolute);
			if (status && outputPath(realpathSync(absolute))) continue;
			// Existence is a discovery input even when the resource is absent or
			// ignored by Git. The helper's virtual inventory still owns its own
			// bounded probing and rejects directory-wide enumeration below.
			onResourcePath?.(absolute);
			if (inventoried || status?.isFile()) {
				files.add(relative);
				if (entry && /\.[cm]?[jt]sx?$/.test(relative) && path.resolve(root, relative) !== filename)
					entries.add(relative);
			} else if (directoryInput) {
				const matcher = pattern === undefined ? undefined : new Bun.Glob(pattern);
				const matches = (file: string): boolean =>
					!matcher || matcher.match(path.isAbsolute(pattern!) ? path.resolve(absolute, file) : file);
				for (const file of inventory)
					if (
						(!relative || file.startsWith(`${relative}/`)) &&
						matches(path.relative(absolute, path.resolve(root, file)).replaceAll("\\", "/"))
					)
						files.add(file);
				if (!status?.isDirectory()) continue;
				// scan(cwd) does not mean read every file below cwd: retain the
				// receiver's real Glob pattern. Prefix matchers watch each directory
				// where a new match can appear, without visiting unrelated trees.
				const parts = pattern?.replaceAll("\\", "/").replace(/^\.\//, "").split("/");
				const prefixes =
					parts && !path.isAbsolute(pattern!) && !/[{}()!]/.test(pattern!) && !parts.includes("..")
						? parts.slice(0, -1).map((_, index) => new Bun.Glob(parts.slice(0, index + 1).join("/")))
						: undefined;
				const pending = [absolute];
				for (const current of pending)
					for (const item of readdirSync(current, { withFileTypes: true })) {
						const normalized = resourcePath(path.resolve(current, item.name));
						if (normalized === undefined || outputPath(normalized)) continue;
						const child = path.resolve(normalized);
						const relativeChild = path.relative(root, child).replaceAll("\\", "/");
						if (relativeChild.startsWith("../") || path.isAbsolute(relativeChild)) continue;
						if (process.platform === "win32" && /[<>:"|?*\x00-\x1f]/.test(relativeChild)) continue;
						const scanned = path.relative(absolute, child).replaceAll("\\", "/");
						const directory = item.isDirectory();
						if (directory && prefixes && !prefixes.some(prefix => prefix.match(scanned))) continue;
						if (!directory && !matches(scanned)) continue;
						const linked = item.isSymbolicLink() ? installedPath(child) : undefined;
						if (linked && outputPath(realpathSync(child))) continue;
						onResourcePath?.(child);
						if (directory) pending.push(child);
						else if (installedPath(child)?.isFile()) files.add(relativeChild);
					}
			}
		}
	};
	// The binding pass already walked every node; resource consumers only need
	// calls, not a second recursive walk through large third-party source trees.
	const scanCall = (node: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression): void => {
		if (ts.isTaggedTemplateExpression(node)) {
			if (!shellTag(node.tag)) return;
			const command = value(node.template);
			// Only plain shell words have an unambiguous static argv. Quoting,
			// expansion and operators keep their original conservative boundary.
			if (
				!ts.isNoSubstitutionTemplateLiteral(node.template) ||
				!command ||
				!/^[\p{L}\p{N}_./:@%+=, \t-]+$/u.test(command)
			) {
				fallback = true;
				if (
					ts.isTemplateExpression(node.template) &&
					/^(?:bun|node|npm|pnpm|yarn)\s/.test(node.template.head.text.trimStart())
				)
					repositoryFallback = true;
				return;
			}
			let cwd: string | undefined;
			let temporaryCwd = false;
			for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
				if (ts.isPropertyAccessExpression(parent)) continue;
				if (!ts.isCallExpression(parent)) break;
				if (ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === "cwd") {
					const argument = parent.arguments[0];
					cwd = argument ? value(argument) : undefined;
					temporaryCwd = !!argument && runtimeTemporaryDirectory(argument);
					// A known Node temporary cwd is runtime state, not the repository.
					// Do not evaluate TEMP on this host. Relative script words below
					// still retain the unknown-cwd boundary; absolute inputs are scanned.
					if ((!cwd || !path.isAbsolute(cwd)) && !temporaryCwd) {
						fallback = repositoryFallback = true;
						return;
					}
				}
			}
			const commandWords = command.trim().split(/[ \t]+/);
			const executable = path
				.basename(commandWords[0]!)
				.replace(/\.exe$/i, "")
				.toLowerCase();
			if (["bun", "node", "npm", "pnpm", "yarn"].includes(executable)) {
				let index = 1;
				while (commandWords[index]?.startsWith("--cwd")) index += commandWords[index] === "--cwd" ? 2 : 1;
				const subcommand = commandWords[index];
				if (
					packageCommandKind(executable, subcommand) === "script" &&
					packageScriptInputs(commandWords, root, cwd, (file, isEntry) => add(file, false, isEntry)) === false
				)
					fallback = repositoryFallback = true;
			}
			for (const [index, word] of commandWords.entries()) {
				// Git's relative operands in a proved temporary worktree are data,
				// not scripts. Absolute operands and escaping paths remain inputs.
				if (temporaryCwd && commandWords[0] === "git" && index > 0) {
					const operand = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
					if (!path.isAbsolute(operand) && !operand.split(/[\\/]/).includes("..")) continue;
					if (path.isAbsolute(operand)) {
						add(operand, false, true);
						continue;
					}
				}
				if (!cwd && !path.isAbsolute(word) && /[./\\]/.test(word)) {
					fallback = repositoryFallback = true;
					return;
				}
				add(word, false, true, cwd);
			}
			return;
		}
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
			const candidate = value(node);
			if (candidate !== undefined) add(candidate, false, true);
			else if (anchored(node)) fallback = true;
			return;
		}
		const call = node.expression;
		const name = ts.isIdentifier(call) ? call.text : ts.isPropertyAccessExpression(call) ? call.name.text : "";
		const requireReceiver = ts.isPropertyAccessExpression(call) ? call.expression : call;
		const receiverRole = requireRole(requireReceiver);
		const module =
			call.kind === ts.SyntaxKind.ImportKeyword ||
			(ts.isIdentifier(call) && name === "require" && !constants.has(name)) ||
			(ts.isPropertyAccessExpression(call) &&
				name === "require" &&
				(receiverRole === "module" ||
					// Module objects are commonly forwarded as parameters (for
					// example require-directory). An unresolved local receiver must
					// stay conservative; known business objects are not Node loaders.
					(ts.isIdentifier(requireReceiver) &&
						hasScopedBinding(requireReceiver) &&
						!initializer(requireReceiver))));
		const opaqueRequire =
			receiverRole === "loader" ||
			(ts.isPropertyAccessExpression(call) && name === "require" && receiverRole === "module");
		if (opaqueRequire) {
			const argument = node.arguments?.[0];
			const specifier = argument && value(argument);
			const builtin =
				specifier !== undefined &&
				builtinModules.some(
					item => item === specifier || (specifier.startsWith("node:") && item === specifier.slice(5)),
				);
			if (builtin) return;
			// Only an explicit local filename with a statically known loader base
			// has a closed resolution here; package resolution also depends on
			// manifests and resolution alternatives and remains opaque.
			const loader = dereference(requireReceiver);
			if (
				specifier &&
				/^\.\.?[\\/]/.test(specifier) &&
				/\.[cm]?[jt]sx?$/.test(specifier) &&
				ts.isCallExpression(loader) &&
				requireRole(loader.expression) === "factory" &&
				loader.arguments[0]
			) {
				const base = value(loader.arguments[0]);
				if (base) {
					try {
						const resolved = createRequire(base).resolve(specifier);
						const lexical = path.resolve(
							path.dirname(base.startsWith("file:") ? fileURLToPath(base) : base),
							specifier,
						);
						const real = realpathSync(resolved);
						const withinRoot = (file: string): boolean => {
							const relative = path.relative(root, file);
							return !relative.startsWith("..") && !path.isAbsolute(relative);
						};
						if (withinRoot(lexical) && withinRoot(resolved) && withinRoot(real) && existsSync(resolved)) {
							add(lexical, false, true);
							add(resolved, false, true);
							add(real, false, true);
							return;
						}
					} catch {
						// Resolution failure must retain the original opaque boundary.
					}
				}
			}
			fallback = true;
			return;
		}
		if (module) {
			const argument = node.arguments?.[0];
			if (argument && value(argument) === undefined) fallback = true;
			return;
		}
		let receiver: ts.Expression = call;
		while (ts.isPropertyAccessExpression(receiver) || ts.isCallExpression(receiver)) receiver = receiver.expression;
		if (
			ts.isIdentifier(receiver) &&
			!constants.has(receiver.text) &&
			!(receiver.text === "JSON" && name === "stringify") &&
			(assertions.has(receiver.text) ||
				/^(?:console|JSON|Object|Promise|Response|Request|Headers|TextDecoder|TextEncoder|Buffer|String|Number|Boolean|Array|Map|Set|Error|RegExp|Date)$/.test(
					receiver.text,
				))
		)
			return;
		if (
			/^(?:write|writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rename|renameSync)$/.test(
				name,
			)
		)
			return;
		// Path constructors are consumed by the read/spawn/worker call, not by
		// themselves: declaring a REPO_ROOT constant must not select the repo.
		if (ts.isIdentifier(call) && paths.has(call.text)) return;
		if (
			ts.isPropertyAccessExpression(call) &&
			ts.isIdentifier(call.expression) &&
			namespaces.has(call.expression.text)
		)
			return;
		const directoryInput = /^(?:readdir|readdirSync|opendir|opendirSync|glob|scan|scanSync)$/.test(name);
		const pattern =
			/^(?:scan|scanSync)$/.test(name) && ts.isPropertyAccessExpression(call)
				? globPattern(call.expression)
				: undefined;
		const entry = /^(?:spawn|spawnSync|exec|execFile|execFileSync|fork|Worker|URL)$/.test(name);
		let processCwd: string | undefined;
		let temporaryProcessCwd = false;
		if (entry)
			for (const argument of node.arguments ?? []) {
				const cwd = structuredProperty(argument, "cwd");
				if (!cwd) continue;
				processCwd = value(cwd);
				temporaryProcessCwd = runtimeTemporaryDirectory(cwd);
				if (processCwd === undefined && !temporaryProcessCwd && anchored(cwd)) {
					fallback = repositoryFallback = true;
				} else if (processCwd !== undefined && !path.isAbsolute(processCwd)) {
					// Do not resolve a relative cwd against the discovery process.
					// Relative source operands and package scripts below retain the
					// conservative boundary when their real base is unknown.
					processCwd = undefined;
				}
			}
		if (/^(?:spawn|spawnSync|execFile|execFileSync)$/.test(name)) {
			const args = node.arguments ?? [];
			const first = args[0];
			const command = first && (structuredProperty(first, "cmd") ?? first);
			const array = command && dereference(command);
			let argv: (string | undefined)[] | undefined;
			if (array && ts.isArrayLiteralExpression(array))
				argv = array.elements.map(element => (ts.isExpression(element) ? value(element) : undefined));
			else if (command) {
				const extra = args[1] && dereference(args[1]);
				if (extra && ts.isArrayLiteralExpression(extra))
					argv = [
						value(command),
						...extra.elements.map(element => (ts.isExpression(element) ? value(element) : undefined)),
					];
			}
			const knownProcess = ts.isIdentifier(call)
				? !hasScopedBinding(call) && dataFunctions.has(call.text)
				: ts.isPropertyAccessExpression(call) &&
					ts.isIdentifier(call.expression) &&
					!hasScopedBinding(call.expression) &&
					(call.expression.text === "Bun" ||
						dataNamespaces.get(call.expression.text) === processDataCalls ||
						dataNamespaces.get(call.expression.text) === bunDataCalls);
			if (
				knownProcess &&
				argv?.length &&
				argv[0] === undefined &&
				(argv[1] === "run" || argv[1] === "run-script" || argv[1] === "--run")
			)
				fallback = repositoryFallback = true;
			if (argv?.length) {
				const executable =
					argv[0] &&
					path
						.basename(argv[0])
						.replace(/\.exe$/i, "")
						.toLowerCase();
				if (executable && ["bun", "node", "npm", "pnpm", "yarn"].includes(executable)) {
					let index = 1;
					while (argv[index]?.startsWith("--cwd")) index += argv[index] === "--cwd" ? 2 : 1;
					const subcommand = argv[index];
					if (
						!processCwd &&
						argv
							.slice(index)
							.some(
								word => word && !word.startsWith("-") && /\.[cm]?[jt]sx?$/.test(word) && !path.isAbsolute(word),
							)
					)
						fallback = repositoryFallback = true;
					// An opaque forwarded argv need not be a repository script;
					// literal script commands are handled by the expansion below.
					if (
						packageCommandKind(executable, subcommand) === "script" &&
						packageScriptInputs(argv, root, processCwd, (file, isEntry) => add(file, false, isEntry)) === false
					)
						fallback = repositoryFallback = true;
				}
				if (!executable && !processCwd && argv[1] && /\.[cm]?[jt]sx?$/.test(argv[1]) && !path.isAbsolute(argv[1]))
					fallback = repositoryFallback = true;
			}
		}
		const consume = (argument: ts.Expression, structured = false): void => {
			if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return;
			if (ts.isParenthesizedExpression(argument) || ts.isAsExpression(argument) || ts.isNonNullExpression(argument))
				return consume(argument.expression, structured);
			if (entry && ts.isCallExpression(argument)) {
				const command = structuredProperty(argument, "cmd");
				if (command) {
					consume(command);
					return;
				}
			}
			if (!directoryInput && generatedPath(argument)) return;
			const words = formattedWords(argument);
			if (words) {
				for (const word of words) consume(word, true);
				return;
			}
			if (ts.isIdentifier(argument)) {
				const expression = initializer(argument);
				if (expression && (ts.isArrayLiteralExpression(expression) || ts.isObjectLiteralExpression(expression))) {
					consume(expression, structured);
					return;
				}
			}
			if (ts.isArrayLiteralExpression(argument)) {
				for (const element of argument.elements) if (ts.isExpression(element)) consume(element, structured);
				return;
			}
			if (directoryInput && ts.isObjectLiteralExpression(argument)) {
				for (const property of argument.properties)
					if (ts.isPropertyAssignment(property) && property.name.getText(source) === "cwd")
						consume(property.initializer);
				return;
			}
			if (entry && ts.isObjectLiteralExpression(argument)) {
				for (const property of argument.properties)
					if (ts.isPropertyAssignment(property) && property.name.getText(source) === "cmd")
						consume(property.initializer);
				const first = node.arguments?.[0];
				const firstObject = first && ts.isIdentifier(first) ? initializer(first) : first;
				if (
					argument === firstObject &&
					anchored(argument) &&
					!argument.properties.some(
						property => ts.isPropertyAssignment(property) && property.name.getText(source) === "cmd",
					)
				)
					fallback = true;
				return;
			}
			if (ts.isObjectLiteralExpression(argument)) {
				if (
					!structured &&
					!(
						(ts.isIdentifier(call) && !constants.has(call.text) && structuredFunctions.get(call.text)) ||
						(ts.isPropertyAccessExpression(call) &&
							ts.isIdentifier(call.expression) &&
							call.expression.text === "JSON" &&
							!constants.has("JSON") &&
							call.name.text === "stringify")
					)
				)
					return;
				for (const property of argument.properties) {
					const expression = ts.isPropertyAssignment(property)
						? property.initializer
						: ts.isShorthandPropertyAssignment(property)
							? property.name
							: undefined;
					if (!expression || !anchored(expression)) continue;
					consume(expression, true);
				}
				return;
			}
			const candidate = value(argument);
			if (candidate !== undefined) add(candidate, directoryInput, entry || structured, processCwd, pattern);
			else if (anchored(argument)) fallback = true;
		};
		for (const argument of node.arguments ?? []) consume(argument);
	};
	for (const node of calls) {
		const loops: { loop: ts.Node; values: readonly ts.Expression[] }[] = [];
		for (let parent = parents.get(node); parent; parent = parents.get(parent)) {
			if (
				(ts.isArrowFunction(parent) || ts.isFunctionExpression(parent)) &&
				parent.parameters.length === 1 &&
				ts.isIdentifier(parent.parameters[0]!.name)
			) {
				const map = parents.get(parent);
				if (
					map &&
					ts.isCallExpression(map) &&
					ts.isPropertyAccessExpression(map.expression) &&
					map.expression.name.text === "map" &&
					ts.isArrayLiteralExpression(map.expression.expression) &&
					map.expression.expression.elements.every(ts.isStringLiteralLike)
				)
					loops.push({ loop: parent, values: map.expression.expression.elements });
			}
			if (
				!ts.isForOfStatement(parent) ||
				!ts.isVariableDeclarationList(parent.initializer) ||
				(parent.initializer.flags & ts.NodeFlags.Const) === 0 ||
				parent.initializer.declarations.length !== 1 ||
				!ts.isIdentifier(parent.initializer.declarations[0]!.name) ||
				!ts.isArrayLiteralExpression(parent.expression) ||
				!parent.expression.elements.every(ts.isStringLiteralLike)
			)
				continue;
			loops.push({ loop: parent, values: parent.expression.elements });
		}
		const scan = (index: number): void => {
			const context = loops[index];
			if (!context) return scanCall(node);
			for (const element of context.values) {
				loopValues.set(context.loop, element);
				scan(index + 1);
			}
			loopValues.delete(context.loop);
		};
		scan(0);
	}
	return { files: [...files].sort(), entries: [...entries].sort(), fallback, repositoryFallback };
}
