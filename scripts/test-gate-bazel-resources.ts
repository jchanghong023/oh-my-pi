import { existsSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ts } from "@ts-morph/common";

export interface GateResources {
	files: string[];
	entries: string[];
	fallback: boolean;
	repositoryFallback: boolean;
}

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
	const destructuredRequireFactories = new Map<string, ts.Expression>();
	const requireNamespaces = new Set<string>();
	const globFactories = new Set<string>();
	const globNamespaces = new Set<string>();
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
	const calls: (ts.CallExpression | ts.NewExpression)[] = [];
	let fallback = false;
	let repositoryFallback = false;
	const visit = (node: ts.Node, parent?: ts.Node) => {
		collect(node, parent);
		ts.forEachChild(node, child => visit(child, node));
	};
	const bind = (name: ts.BindingName, constant: boolean, initializer?: ts.Expression, module?: ts.Expression) => {
		if (ts.isIdentifier(name)) {
			const duplicate = constants.has(name.text);
			constants.set(name.text, duplicate || !constant ? undefined : initializer);
			if (duplicate || !constant) destructuredRequireFactories.delete(name.text);
			else if (module) destructuredRequireFactories.set(name.text, module);
			return;
		}
		for (const element of name.elements) {
			if (ts.isOmittedExpression(element)) continue;
			const property = element.propertyName ?? element.name;
			const factory =
				ts.isObjectBindingPattern(name) &&
				!element.dotDotDotToken &&
				!element.initializer &&
				(ts.isIdentifier(property) || ts.isStringLiteral(property)) &&
				property.text === "createRequire";
			bind(element.name, constant, undefined, factory ? initializer : undefined);
		}
	};
	const collect = (node: ts.Node, parent?: ts.Node) => {
		if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const module = node.moduleSpecifier.text.replace(/^node:/, "");
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
					for (const binding of bindings.elements)
						if ((binding.propertyName ?? binding.name).text === "Glob") globFactories.add(binding.name.text);
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
			bind(node.name, constant, node.initializer);
		}
	};
	visit(source);
	// Resolve roles only after every binding is collected: aliases can precede
	// declarations, and duplicate/parameter bindings must invalidate imports.
	// Only module namespaces, their createRequire factories, and the resulting
	// loaders propagate a role; ordinary data/function aliases remain unrelated.
	type RequireRole = "namespace" | "factory" | "loader";
	const requireRoles = new Map<string, RequireRole | undefined>();
	const resolvingRequireNames = new Set<string>();
	const requireRole = (node: ts.Expression): RequireRole | undefined => {
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
			return requireRole(node.expression);
		if (ts.isIdentifier(node)) {
			const name = node.text;
			if (resolvingRequireNames.has(name)) return undefined;
			if (requireRoles.has(name)) return requireRoles.get(name);
			resolvingRequireNames.add(name);
			const expression = constants.get(name);
			const destructured = destructuredRequireFactories.get(name);
			const role = destructured
				? requireRole(destructured) === "namespace"
					? "factory"
					: undefined
				: constants.has(name)
					? expression
						? requireRole(expression)
						: undefined
					: requireFactories.has(name)
						? "factory"
						: requireNamespaces.has(name)
							? "namespace"
							: undefined;
			resolvingRequireNames.delete(name);
			requireRoles.set(name, role);
			return role;
		}
		if (
			ts.isPropertyAccessExpression(node) &&
			node.name.text === "createRequire" &&
			requireRole(node.expression) === "namespace"
		)
			return "factory";
		if (ts.isCallExpression(node)) {
			if (
				ts.isIdentifier(node.expression) &&
				node.expression.text === "require" &&
				!constants.has("require") &&
				node.arguments.length === 1 &&
				ts.isStringLiteralLike(node.arguments[0]) &&
				/^(?:node:)?module$/.test(node.arguments[0].text)
			)
				return "namespace";
			if (requireRole(node.expression) === "factory") return "loader";
		}
		return undefined;
	};
	const value = (node: ts.Expression, seen = new Set<string>()): string | undefined => {
		if (ts.isStringLiteralLike(node)) return node.text;
		if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node))
			return value(node.expression, seen);
		if (ts.isIdentifier(node)) {
			if (node.text === "__dirname") return directory;
			if (node.text === "__filename") return filename;
			if (seen.has(node.text)) return undefined;
			const expression = constants.get(node.text);
			return expression ? value(expression, new Set([...seen, node.text])) : undefined;
		}
		if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)) {
			if (node.name.text === "dir") return directory;
			if (node.name.text === "url") return pathToFileURL(filename).href;
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
		}
		return undefined;
	};
	const anchored = (node: ts.Node, seen = new Set<string>()): boolean => {
		if (!mayHaveAnchor) return false;
		if (ts.isMetaProperty(node) || (ts.isIdentifier(node) && /^(?:__dirname|__filename)$/.test(node.text)))
			return true;
		if (ts.isPropertyAccessExpression(node)) return anchored(node.expression, seen);
		if (ts.isCallExpression(node)) {
			const call = node.expression;
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
			const expression = constants.get(node.text);
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
	calls.forEach(node => {
		if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL") {
			const candidate = value(node);
			if (candidate !== undefined) add(candidate, false, true);
			else if (anchored(node)) fallback = true;
			return;
		}
		const call = node.expression;
		const name = ts.isIdentifier(call) ? call.text : ts.isPropertyAccessExpression(call) ? call.name.text : "";
		const module = call.kind === ts.SyntaxKind.ImportKeyword || name === "require";
		const requireReceiver = ts.isPropertyAccessExpression(call) ? call.expression : call;
		const opaqueRequire = requireRole(requireReceiver) === "loader";
		if (opaqueRequire) {
			// Bun does not include createRequire() loads in its module graph.
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
		if (entry)
			for (const argument of node.arguments ?? []) {
				const object = ts.isIdentifier(argument) ? constants.get(argument.text) : argument;
				if (!object || !ts.isObjectLiteralExpression(object)) continue;
				for (const property of object.properties)
					if (ts.isPropertyAssignment(property) && property.name.getText(source) === "cwd") {
						processCwd = value(property.initializer);
						if (processCwd === undefined && anchored(property.initializer)) {
							fallback = repositoryFallback = true;
						} else if (processCwd !== undefined && !path.isAbsolute(processCwd)) {
							// A shared module can run under different caller working directories.
							// Never resolve relative cwd against this discovery process's cwd.
							fallback = repositoryFallback = true;
							processCwd = undefined;
						}
					}
			}
		const consume = (argument: ts.Expression) => {
			if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return;
			if (ts.isIdentifier(argument)) {
				const initializer = constants.get(argument.text);
				if (
					initializer &&
					(ts.isArrayLiteralExpression(initializer) || ts.isObjectLiteralExpression(initializer))
				) {
					consume(initializer);
					return;
				}
			}
			if (ts.isArrayLiteralExpression(argument)) {
				for (const element of argument.elements) if (ts.isExpression(element)) consume(element);
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
				const firstObject = first && ts.isIdentifier(first) ? constants.get(first.text) : first;
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
			if (ts.isObjectLiteralExpression(argument)) return;
			const candidate = value(argument);
			if (candidate !== undefined) add(candidate, directoryInput, entry, processCwd, pattern);
			else if (anchored(argument)) fallback = true;
		};
		for (const argument of node.arguments ?? []) consume(argument);
	});
	return { files: [...files].sort(), entries: [...entries].sort(), fallback, repositoryFallback };
}
