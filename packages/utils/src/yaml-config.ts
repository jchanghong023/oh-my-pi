import { YAML } from "bun";
import { type Alias, isAlias, isMap, isNode, type Node, parseDocument, visit } from "yaml";

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
	// A role may live behind an alias. Edit a private copy rather than its shared source.
	for (let length = 1; length <= keys.length; length++) {
		const prefix = keys.slice(0, length);
		const node = doc.getIn(prefix, true);
		if (isAlias(node)) doc.setIn(prefix, expandAlias(node));
	}
	const existing = doc.getIn(keys, true);
	const changedNodes = new Set<Node>();
	for (let length = 0; length < keys.length; length++) {
		const ancestor = doc.getIn(keys.slice(0, length), true);
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
		const parent = doc.getIn(keys.slice(0, -1), true);
		if (isMap(parent)) {
			const pair = parent.items.find(item => isNode(item.key) && item.key.toJSON() === keys.at(-1));
			// 删除角色仍保留其注释；否则 GUI 取消模型会悄悄丢掉用户说明。
			const retainedComments = [
				isNode(pair?.key) ? pair.key.commentBefore : undefined,
				isNode(pair?.key) ? pair.key.comment : undefined,
				...comments,
			].filter(Boolean);
			if (retainedComments.length > 0)
				parent.comment = [parent.comment, ...retainedComments].filter(Boolean).join("\n");
		}
		doc.deleteIn(keys);
	} else {
		const replacement = doc.createNode(value);
		if (comments.length > 0) replacement.commentBefore = comments.join("\n");
		if (isNode(existing)) replacement.spaceBefore = existing.spaceBefore;
		doc.setIn(keys, replacement);
	}
	return doc.toString({ lineWidth: 0 });
}
