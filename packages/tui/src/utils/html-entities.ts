const ENTITY: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/** Decode HTML character references as drawn by the terminal Markdown renderer. */
export function decodeEntities(text: string): string {
	if (!text.includes("&")) return text;
	return text.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (whole, body: string) => {
		if (body[0] === "#") {
			const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
		}
		return ENTITY[body.toLowerCase()] ?? whole;
	});
}
