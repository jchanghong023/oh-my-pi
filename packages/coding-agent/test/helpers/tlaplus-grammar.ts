import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __ompSetGrammarDir, wasmGrammarFor } from "@oh-my-pi/pi-natives";
import { getNativeGrammarsDir, removeWithRetries } from "@oh-my-pi/pi-utils";

/** Use the real pinned tree-sitter-tlaplus 1.5.0 grammar without network or personal cache access. */
export async function withTlaplusGrammar<T>(run: () => Promise<T>): Promise<T> {
	const info = wasmGrammarFor({ lang: "tlaplus" });
	if (!info) throw new Error("TLA+ must have a pinned WASM grammar");
	// 隔离 HOME 中没有个人语法缓存；在线下载失败不能让真实 AST 回归随机失效。
	// 夹具来自原生固定版本的 grammar 资源，校验后仅为当前用例临时切换目录。
	const compressed = await Bun.file(
		path.join(import.meta.dir, "../fixtures/tlaplus-2bb6711906017f86.wasm.zst"),
	).bytes();
	const wasm = Bun.zstdDecompressSync(compressed);
	const digest = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
	if (wasm.byteLength !== info.size || digest !== info.sha256)
		throw new Error("TLA+ grammar fixture does not match the native pin");
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-tlaplus-"));
	try {
		await Bun.write(path.join(directory, info.file), wasm);
		__ompSetGrammarDir(directory);
		return await run();
	} finally {
		__ompSetGrammarDir(getNativeGrammarsDir());
		await removeWithRetries(directory);
	}
}
