import { expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { buildTodoLoopGroupPrompt } from "../../src/todoloop/context";
import { readTodoLoop } from "../../src/todoloop/parser";

test("packages BOM-prefixed CR-only tasks without losing continuation delimiters", async () => {
	await using cwd = await TempDir.create("@omp-todoloop-context-");
	const filePath = cwd.join("work.md");
	await Bun.write(filePath, "\uFEFF- [ ] 1 First\r  Keep this acceptance.\r- [ ] 2 Second\r");
	const snapshot = await readTodoLoop(filePath);
	const prompt = await buildTodoLoopGroupPrompt({
		filePath,
		cwd: cwd.path(),
		group: snapshot.groups[0]!,
		attempt: 1,
	});
	const match = /```json\r?\n([\s\S]*?)\r?\n```/.exec(prompt);
	if (!match) throw new Error("Missing task package");
	expect(JSON.parse(match[1]!).group.tasks).toEqual([
		{ id: "1", label: "1", raw: "\uFEFF- [ ] 1 First\r  Keep this acceptance." },
		{ id: "2", label: "2", raw: "- [ ] 2 Second" },
	]);
});
