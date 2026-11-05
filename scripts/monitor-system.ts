#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatBytes, isEnoent } from "@oh-my-pi/pi-utils";

interface MonitorStatus {
	status: "running" | "stopped" | "failed";
	pid: number;
	error?: string;
}

interface Sample {
	timestamp: string;
	cpuPercent: number;
	memoryUsedBytes: number;
	memoryTotalBytes: number;
	memoryPercent: number;
	collectionMs: number;
	volumes: { name: string; usedBytes: number; totalBytes: number; usedPercent: number }[];
	disks: {
		name: string;
		busyPercent: number | null;
		readBytesPerSecond: number;
		writeBytesPerSecond: number;
		queueLength: number;
	}[];
}

async function status(directory: string): Promise<MonitorStatus | undefined> {
	try {
		return await Bun.file(path.join(directory, "status.json")).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}
async function collect(directory: string): Promise<void> {
	// PowerShell needs a console-capable launch; keep its hidden owner alive in
	// a detached Bun process instead of passing DETACHED_PROCESS to PowerShell.
	const child = Bun.spawn(
		[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			path.join(import.meta.dir, "monitor-system.ps1"),
			"-OutputDirectory",
			directory,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "inherit", windowsHide: true },
	);
	process.exitCode = await child.exited;
}

async function start(): Promise<void> {
	if (process.platform !== "win32") throw new Error("此采集器使用 Windows 原生性能计数器，请在 Windows 上运行");
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-monitor-"));
	await Bun.write(
		path.join(directory, "monitor.json"),
		JSON.stringify({ kind: "omp-test-monitor", intervalMs: 2_000 }),
	);
	const child = Bun.spawn([process.execPath, import.meta.path, "--collect", directory], {
		detached: true,
		stdout: "ignore",
		stdin: "ignore",
		windowsHide: true,
		stderr: Bun.file(path.join(directory, "worker.log")),
	});
	while (child.exitCode === null) {
		const current = await status(directory);
		if (current?.status === "running") {
			child.unref();
			console.log(`后台监控已启动，PID ${current.pid}`);
			console.log(`数据：${path.join(directory, "samples.jsonl")}`);
			console.log(`停止：bun scripts/monitor-system.ts --stop "${directory}"`);
			console.log(`分析：bun scripts/monitor-system.ts --report "${directory}"`);
			return;
		}
		if (current?.status === "failed") throw new Error(`${current.error}\n日志：${directory}`);
		await Bun.sleep(50);
	}
	throw new Error(`监控启动失败（退出码 ${child.exitCode}），日志：${directory}`);
}

async function report(directory: string): Promise<void> {
	const samples = Bun.JSONL.parse(await Bun.file(path.join(directory, "samples.jsonl")).text()) as Sample[];
	const current = await status(directory);
	console.log(`状态：${current?.status ?? "unknown"}${current?.error ? ` (${current.error})` : ""}`);
	if (samples.length === 0) throw new Error("尚无性能样本");
	const first = samples[0]!;
	const last = samples[samples.length - 1]!;
	console.log(`区间：${first.timestamp} → ${last.timestamp}，${samples.length} 个样本`);
	const peak = (value: (sample: Sample) => number) =>
		samples.reduce((best, sample) => (value(sample) > value(best) ? sample : best));
	const cpuPeak = peak(sample => sample.cpuPercent);
	const memoryPeak = peak(sample => sample.memoryUsedBytes);
	const averageCpu = samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / samples.length;
	console.log(`CPU：平均 ${averageCpu.toFixed(1)}%，峰值 ${cpuPeak.cpuPercent.toFixed(1)}% (${cpuPeak.timestamp})`);
	console.log(
		`内存：峰值 ${formatBytes(memoryPeak.memoryUsedBytes)} / ${formatBytes(memoryPeak.memoryTotalBytes)}，${memoryPeak.memoryPercent.toFixed(1)}% (${memoryPeak.timestamp})`,
	);
	for (const name of new Set(samples.flatMap(sample => sample.disks.map(disk => disk.name)))) {
		const rows = samples.flatMap(sample => sample.disks.filter(disk => disk.name === name));
		const busy = rows.flatMap(disk => (disk.busyPercent === null ? [] : [disk.busyPercent]));
		const averageBusy = busy.length
			? `${(busy.reduce((sum, value) => sum + value, 0) / busy.length).toFixed(1)}%`
			: "不可用";
		const peakBusy = busy.length ? `${Math.max(...busy).toFixed(1)}%` : "不可用";
		console.log(
			`磁盘 ${name}：I/O 繁忙度平均 ${averageBusy} / 峰值 ${peakBusy}，读取峰值 ${formatBytes(Math.max(...rows.map(disk => disk.readBytesPerSecond)))}/s，写入峰值 ${formatBytes(Math.max(...rows.map(disk => disk.writeBytesPerSecond)))}/s，队列峰值 ${Math.max(...rows.map(disk => disk.queueLength)).toFixed(2)}`,
		);
	}
	for (const volume of last.volumes) {
		console.log(
			`容量 ${volume.name}：${volume.usedPercent.toFixed(1)}%，${formatBytes(volume.usedBytes)} / ${formatBytes(volume.totalBytes)}`,
		);
	}
	console.log(
		`采集耗时：平均 ${(samples.reduce((sum, sample) => sum + sample.collectionMs, 0) / samples.length).toFixed(0)} ms/轮`,
	);
	console.log(`原始数据：${path.join(directory, "samples.jsonl")}`);
}

async function main(): Promise<void> {
	const [command, directory, extra] = process.argv.slice(2);
	if (!command) return start();
	if ((command !== "--stop" && command !== "--report" && command !== "--collect") || !directory || extra) {
		throw new Error("用法：bun scripts/monitor-system.ts [--stop|--report <监控目录>]");
	}
	const manifest = await Bun.file(path.join(directory, "monitor.json")).json();
	if (manifest.kind !== "omp-test-monitor") throw new Error("不是系统监控目录");
	if (command === "--collect") return collect(directory);
	if (command === "--report") return report(directory);
	await Bun.write(path.join(directory, "stop"), "stop\n");
	console.log(`已请求停止；当前采集结束后退出，数据保留在 ${directory}`);
}

if (import.meta.main) {
	await main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
