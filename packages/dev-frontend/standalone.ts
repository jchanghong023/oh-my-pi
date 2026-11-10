import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// 第一阶段只运行现有复制版前端；依赖安装不进入祖先仓库的 workspace。
const root = import.meta.dirname;
const modules = path.join(root, "node_modules");
const vite = path.join(modules, "vite/bin/vite.js");
const marker = path.join(modules, ".dev-frontend-install");
const manifest = (await Bun.file(path.join(root, "package.json")).json()) as {
	name: string;
	version: string;
	dependencies: Record<string, string>;
};
const lock = await Bun.file(path.join(root, "bun.lock")).text();
const fingerprint = new Bun.CryptoHasher("sha256")
	.update(JSON.stringify(manifest.dependencies))
	.update(lock)
	.digest("hex");

if (!Bun.semver.satisfies(Bun.version, ">=1.4.4")) {
	throw new Error("此阶段性前端原型需要 Bun >= 1.4.4。");
}

const command = process.argv[2] ?? "start";
if (process.argv.length > 3 || !["install", "start", "build"].includes(command)) {
	throw new Error("用法：bun ./standalone.ts install | start | build");
}

if (command === "install") {
	const staging = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dev-frontend-install-"));
	try {
		// 临时目录只有 npm 依赖清单和锁文件，绝不复制源码或创建第二套界面。
		await Bun.write(
			path.join(staging, "package.json"),
			JSON.stringify(
				{
					name: manifest.name,
					version: manifest.version,
					private: true,
					type: "module",
					dependencies: manifest.dependencies,
				},
				null,
				2,
			),
		);
		await Bun.write(path.join(staging, "bun.lock"), lock);
		const installer = Bun.spawn({
			cmd: [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--linker", "hoisted"],
			cwd: staging,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await installer.exited;
		if (code !== 0) process.exitCode = code;
		else {
			// 只替换本包的生成依赖；源码、假数据及锁文件始终保留在本包。
			await fs.rm(modules, { recursive: true, force: true });
			await fs.cp(path.join(staging, "node_modules"), modules, {
				recursive: true,
				verbatimSymlinks: true,
			});
			await Bun.write(marker, fingerprint);
			console.log("本包独立依赖已安装。启动：bun ./standalone.ts start");
		}
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
} else {
	const installedFingerprint = await Bun.file(marker)
		.text()
		.catch((cause: unknown) => {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
			throw cause;
		});
	if (installedFingerprint !== fingerprint) {
		throw new Error("请先在本包目录执行 bun ./standalone.ts install；不要在祖先仓库运行 bun install。");
	}
	const args = command === "build" ? ["build"] : [];
	const child = Bun.spawn({
		cmd: [process.execPath, vite, ...args, "--config", path.join(root, "preview/vite.config.ts")],
		cwd: root,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	const stop = () => child.kill();
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	try {
		process.exitCode = await child.exited;
	} finally {
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
	}
}
