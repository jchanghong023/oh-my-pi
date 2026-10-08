import { describe, expect, test } from "bun:test";
import { Lexer } from "../src/marked";

describe("Markdown fence line separators", () => {
	test("keeps Unicode separators inside backtick and tilde fence info rather than interpreting code as emphasis", () => {
		const source =
			"lead\n```python\u2028metadata\ncounter*factor*next\n```\n~~~`literal`\u2029metadata\nmask*value*next\n~~~\n";
		const tokens = Lexer.lex(source);
		expect(tokens.map(token => token.type)).toEqual(["paragraph", "code", "code"]);
		expect(tokens[1]).toMatchObject({
			type: "code",
			lang: "python\u2028metadata",
			text: "counter*factor*next",
		});
		expect(tokens[2]).toMatchObject({
			type: "code",
			lang: "`literal`\u2029metadata",
			text: "mask*value*next",
		});
	});
});
