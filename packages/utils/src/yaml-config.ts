import { YAML } from "bun";
import { type Alias, isAlias, isMap, isNode, isScalar, type Node, parseDocument, visit } from "yaml";

const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

/** Serialize config YAML without Bun's trailing space on block mapping headers. */
export function stringifyYamlConfig(value: unknown): string {
	return YAML.stringify(value, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
}

/** Change one config field without losing comments from the locked source document. */
export function setYamlConfigValue(source: string, keys: readonly string[], value: string | undefined): string {
	const doc = parseDocument(source);
	if (doc.errors.length > 0) throw new Error("Settings YAML cannot be edited without losing its structure.");
	const expandAlias = (alias: Alias): Node => {
		const expanded = doc.createNode(alias.toJS(doc), { aliasDuplicateObjects: false });
		expanded.commentBefore = alias.commentBefore;
		expanded.comment = alias.comment;
		expanded.spaceBefore = alias.spaceBefore;
		return expanded;
	};
	// YAML scalar keys become strings in settings records, but AST lookup compares their types.
	// Retain the actual key nodes so numeric/boolean custom role IDs update or delete in place.
	const resolvedKeys: unknown[] = [];
	// A role may live behind an alias. Edit a private copy rather than its shared source.
	for (const key of keys) {
		const parent = doc.getIn(resolvedKeys, true);
		const pair = isMap(parent)
			? parent.items.find(item => isScalar(item.key) && String(item.key.value) === key)
			: undefined;
		resolvedKeys.push(pair ? pair.key : key);
		const node = doc.getIn(resolvedKeys, true);
		if (isAlias(node)) doc.setIn(resolvedKeys, expandAlias(node));
	}
	const existing = doc.getIn(resolvedKeys, true);
	const changedNodes = new Set<Node>();
	for (let length = 0; length < keys.length; length++) {
		const ancestor = doc.getIn(resolvedKeys.slice(0, length), true);
		if (isNode(ancestor)) changedNodes.add(ancestor);
	}
	if (isNode(existing))
		visit(existing, {
			Node: (_key, node) => {
				changedNodes.add(node);
			},
		});
	// Snapshot aliases before changing/removing their anchor, including aliases of the role map.
	const detached = new Map<Alias, Node>();
	visit(doc, {
		Alias: (_key, alias) => {
			const target = alias.resolve(doc);
			if (target && changedNodes.has(target)) detached.set(alias, expandAlias(alias));
		},
	});
	if (detached.size > 0) visit(doc, { Alias: (_key, alias) => detached.get(alias) });
	const comments: string[] = [];
	if (isNode(existing)) {
		visit(existing, {
			Node: (_key, node) => {
				if (node.commentBefore) comments.push(node.commentBefore);
				if (node.comment) comments.push(node.comment);
			},
		});
	}
	if (value === undefined) {
		const parent = doc.getIn(resolvedKeys.slice(0, -1), true);
		if (isMap(parent)) {
			const pair = parent.items.find(item => item.key === resolvedKeys.at(-1));
			// 删除角色仍保留其注释；否则 GUI 取消模型会悄悄丢掉用户说明。
			const retainedComments = [
				isNode(pair?.key) ? pair.key.commentBefore : undefined,
				isNode(pair?.key) ? pair.key.comment : undefined,
				...comments,
			].filter(Boolean);
			if (retainedComments.length > 0)
				parent.comment = [parent.comment, ...retainedComments].filter(Boolean).join("\n");
		}
		doc.deleteIn(resolvedKeys);
	} else {
		// Null means unset: promote it to a mapping while retaining its comments.
		// Aliases were detached above so they keep the previous null value, not the new map.
		for (let length = 0; length < resolvedKeys.length; length++) {
			const path = resolvedKeys.slice(0, length);
			const ancestor = doc.getIn(path, true);
			if (isScalar(ancestor) && ancestor.value === null) {
				const mapping = doc.createNode({});
				mapping.commentBefore = ancestor.commentBefore;
				mapping.comment = ancestor.comment;
				mapping.spaceBefore = ancestor.spaceBefore;
				doc.setIn(path, mapping);
			}
		}
		const replacement = doc.createNode(value);
		if (comments.length > 0) replacement.commentBefore = comments.join("\n");
		if (isNode(existing)) replacement.spaceBefore = existing.spaceBefore;
		doc.setIn(resolvedKeys, replacement);
	}
	return doc.toString({ lineWidth: 0 });
}
