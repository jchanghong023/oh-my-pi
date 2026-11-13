import { describe, expect, test } from "bun:test";
import {
	buildEmbeddedArchive,
	decodeEmbeddedArchive,
	extractEmbeddedArchive,
	hasEmbeddedArchive,
} from "@oh-my-pi/pi-utils/embedded-archive";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("embedded archive", () => {
	test("round-trips files and infers MIME types", async () => {
		const source = new Map([
			["index.html", bytes("<html></html>")],
			["assets/app.js", bytes("console.log(1)")],
			["assets/pixel.ico", new Uint8Array([0, 0, 1, 0])],
		]);
		const text = await buildEmbeddedArchive(source);
		expect(hasEmbeddedArchive(text)).toBe(true);

		const archive = decodeEmbeddedArchive(text);
		expect(archive).not.toBeNull();
		const files = await extractEmbeddedArchive(archive!);
		expect([...files.keys()].sort()).toEqual(["assets/app.js", "assets/pixel.ico", "index.html"]);
		expect(await files.get("assets/app.js")!.text()).toBe("console.log(1)");
		expect(files.get("assets/app.js")!.type).toStartWith("text/javascript");
		expect(files.get("index.html")!.type).toStartWith("text/html");
	});

	test("is deterministic for identical input regardless of insertion order", async () => {
		const first = new Map([
			["a.txt", bytes("a")],
			["b/c.txt", bytes("c")],
		]);
		const second = new Map([
			["b/c.txt", bytes("c")],
			["a.txt", bytes("a")],
		]);
		expect(await buildEmbeddedArchive(first)).toBe(await buildEmbeddedArchive(second));
	});

	test("treats blank, placeholder and non-gzip text as absent", () => {
		expect(hasEmbeddedArchive("")).toBe(false);
		expect(hasEmbeddedArchive('export const x = "";')).toBe(false);
		expect(decodeEmbeddedArchive("")).toBeNull();
		expect(decodeEmbeddedArchive("  \n")).toBeNull();
		expect(decodeEmbeddedArchive("not base64")).toBeNull();
		expect(decodeEmbeddedArchive(Buffer.from("not gzip").toString("base64"))).toBeNull();
	});
});
