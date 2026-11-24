import { expect, it } from "bun:test";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { settle } from "@oh-my-pi/pi-tui/surface";
import { mountVt } from "./helpers/vt-surface";

it("keeps the whole settled prose after an older live prefix stops blocking retirement", async () => {
	const prose = Array.from({ length: 40 }, (_, i) => `ARTICLE_${String(i).padStart(2, "0")}`);
	const prefix = ["USER_FIRST", "USER_MIDDLE", "USER_LAST"];
	const { vt, surface, backend, dispose } = mountVt(
		() => ({
			main: [jsx("rows", { key: "user", lines: prefix }), jsx("md", { key: "reply", text: prose.join("\n\n") })],
			dock: jsx("text", { children: "EDITOR" }),
		}),
		{ columns: 60, rows: 12 },
	);
	try {
		settle(surface.main()[1]!);
		backend.renderNow();
		expect(vt.scrollback()).toEqual([]);
		settle(surface.main()[0]!);
		backend.renderNow();
		expect<string[] | null>(
			vt
				.transcript()
				.join("\n")
				.match(/(?:USER_\w+|ARTICLE_\d+)/g),
		).toEqual([...prefix, ...prose]);
		expect(vt.screen()).toContain("EDITOR");
	} finally {
		await dispose();
	}
});

it.each(["fence", "table", "late inline markup"] as const)(
	"replays every %s row once after a live width change",
	async kind => {
		const tokens = Array.from({ length: 18 }, (_, i) => `PART_${String(i).padStart(2, "0")}`);
		const source = signal("");
		const { vt, driver, surface, backend, dispose } = mountVt(
			() => ({
				main: jsx("md", { key: "stream", text: source, stream: true }),
				dock: jsx("text", { children: "EDITOR" }),
			}),
			{ columns: 80, rows: 12, resizeScrollback: "rebuild" },
		);
		const markdown = (count: number, done = false) => {
			const parts = tokens.slice(0, count);
			if (kind === "fence") return `Opening paragraph\n\n\`\`\`text\n${parts.join("\n")}${done ? "\n```" : ""}`;
			if (kind === "table")
				return `Opening paragraph\n\n| left | right |\n| --- | --- |\n${parts.map(token => `| ${token} | kept |`).join("\n")}`;
			return `Opening paragraph\n\n**${parts.join(" repeated,repeated;!? ")}${done ? "**" : ""}`;
		};
		try {
			for (let count = 1; count <= tokens.length; count++) {
				source.set(markdown(count));
				backend.renderNow();
				if (count === 8 || count === 15) {
					driver.resize(count === 8 ? 28 : 75, 12);
					await vt.settle();
					backend.renderNow();
				}
			}
			source.set(`${markdown(tokens.length, true)}\n\nEND_BODY`);
			settle(surface.main()[0]!);
			backend.renderNow();
			expect<string[] | null>(
				vt
					.transcript()
					.join("\n")
					.match(/PART_\d+|END_BODY/g),
			).toEqual([...tokens, "END_BODY"]);
		} finally {
			await dispose();
		}
	},
);
