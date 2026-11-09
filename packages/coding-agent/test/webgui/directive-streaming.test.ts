import { expect, test } from "bun:test";
import {
	findMarkdownCodeRanges,
	findUnclosedAssistantDirectiveStart,
} from "../../../../vendor/zcode-frontend/packages/ui/src/lib/assistantDirectiveParser";

test("streamed directives hide only an incomplete tail and stop hiding it when completed", () => {
	const prefix = "正在生成：";
	const incomplete = `${prefix}::zcode-file-citation{path="report`;
	expect(findUnclosedAssistantDirectiveStart(incomplete, "zcode-file-citation")).toBe(prefix.length);
	expect(findUnclosedAssistantDirectiveStart(`${incomplete}.md"}`, "zcode-file-citation")).toBeNull();
	expect(findUnclosedAssistantDirectiveStart("普通回复不含文件引用。", "zcode-file-citation")).toBeNull();
});

test("streaming ignores protected code examples and invalid colon boundaries before a real directive", () => {
	const example = '```text\n::zcode-file-citation{path="literal\n```\n';
	const invalid = ':::zcode-file-citation{path="invalid\n';
	const content = `${example}${invalid}正文\n::zcode-file-citation{path="actual`;
	expect(findUnclosedAssistantDirectiveStart(invalid, "zcode-file-citation")).toBeNull();
	expect(findUnclosedAssistantDirectiveStart(content, "zcode-file-citation", findMarkdownCodeRanges(content))).toBe(
		content.lastIndexOf("::zcode-file-citation"),
	);
});
