import { YAML } from "bun";
import { isMap, isNode, parseDocument } from "yaml";

const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

/** Serialize config YAML without Bun's trailing space on block mapping headers. */
export function stringifyYamlConfig(value: unknown): string {
	return YAML.stringify(value, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
}

/** Change one config field without losing comments from the locked source document. */
export function setYamlConfigValue(source: string, keys: readonly string[], value: string | undefined): string {
	const doc = parseDocument(source);
	if (doc.errors.length > 0) throw new Error("Settings YAML cannot be edited without losing its structure.");
	if (value === undefined) {
		const existing = doc.getIn(keys, true);
		const parent = doc.getIn(keys.slice(0, -1), true);
		if (isMap(parent)) {
			const pair = parent.items.find(item => isNode(item.key) && item.key.toJSON() === keys.at(-1));
			// 删除角色仍保留其注释；否则 GUI 取消模型会悄悄丢掉用户说明。
			const comments = [
				isNode(pair?.key) ? pair.key.commentBefore : undefined,
				isNode(pair?.key) ? pair.key.comment : undefined,
				isNode(existing) ? existing.commentBefore : undefined,
				isNode(existing) ? existing.comment : undefined,
			].filter(Boolean);
			if (comments.length > 0) parent.comment = [parent.comment, ...comments].filter(Boolean).join("\n");
		}
		doc.deleteIn(keys);
	} else {
		doc.setIn(keys, value);
	}
	return doc.toString({ lineWidth: 0 });
}
