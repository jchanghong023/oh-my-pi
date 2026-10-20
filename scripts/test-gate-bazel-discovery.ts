import * as path from "node:path";
import type { GateInputGraph } from "./test-gate-bazel-inputs";
import { requestPersistentBazel, relayPersistentBazel } from "./test-gate-process";
import type { PersistentBazelClient } from "./test-gate-process";
import { gateClockNanoseconds } from "./test-gate-clock";
import { recordBazelInvocation } from "./test-gate-bazel-report";

if (process.argv[2] === "--native-query-client") {
	const argv = JSON.parse(process.argv[3]!) as string[];
	const outputBase = argv.find(argument => argument.startsWith("--output_base="))!.slice("--output_base=".length);
	const profile = argv.find(argument => argument.startsWith("--profile="))!.slice("--profile=".length);
	const serverPid = async (): Promise<number | null> => {
		try {
			const pid = Number((await Bun.file(path.join(outputBase, "server/server.pid.txt")).text()).trim());
			return Number.isInteger(pid) && pid > 0 ? pid : null;
		} catch {
			return null;
		}
	};
	const serverPidBefore = await serverPid();
	const startedNs = gateClockNanoseconds();
	let code = 1;
	try {
		let clientReady = false;
		let interrupted = false;
		let cancellation: Promise<void> | undefined;
		const cancel = () => {
			interrupted = true;
			if (!clientReady) return;
			cancellation ??= client.cancel();
			void cancellation.catch(error => console.error("Native query cancellation failed:", error));
		};
		process.on("message", message => {
			if (message === "abort") cancel();
		});
		process.on("disconnect", cancel);
		process.on("SIGINT", cancel);
		process.on("SIGTERM", cancel);
		if (!process.connected) cancel();
		else process.send?.({ type: "graph-query-ready" });
		const client: PersistentBazelClient = await requestPersistentBazel(argv);
		clientReady = true;
		if (interrupted) cancel();
		code = await client.exited;
		await cancellation;
	} finally {
		const finishedNs = gateClockNanoseconds();
		const recording = recordBazelInvocation({
			label: "scope/Bazel native cyclic graph query",
			argv,
			cwd: process.cwd(),
			outputBase,
			startedNs,
			finishedNs,
			serverPidBefore,
			serverPidAfter: await serverPid(),
			bep: "",
			profile,
			execution: "",
			explain: "",
			exitCode: code,
		});
		if (code === 0) await recording;
		else void recording.catch(error => console.error("Native query evidence failed:", error));
	}
	process.exit(code);
}

interface GraphRequest {
	bazel: string;
	workspace: string;
	query: string;
	output: string;
	graph: Pick<GateInputGraph, "deps" | "cycleRoots">;
	packageDeps: Record<string, string[]>;
	platformsRoot: string;
}

const hostDiscovery = process.argv[2] === "--host-discovery";
const request = (await Bun.file(process.argv[hostDiscovery ? 3 : 2]!).json()) as GraphRequest;
if (!hostDiscovery) {
	// ctx.execute owns a kill-on-close Windows Job, including normally exited
	// helpers. Native servers must therefore be launched by the gate host.
	// This transport file is read by Bun, not watched as a repository input.
	const context = (await Bun.file(path.join(path.dirname(request.workspace), "context.json")).json()) as {
		graphBroker: { url: string; token: string };
	};
	const broker = context.graphBroker;
	const controller = new AbortController();
	const abort = () => controller.abort(new Error("Native graph discovery interrupted"));
	process.on("SIGINT", abort);
	process.on("SIGTERM", abort);
	process.on("disconnect", abort);
	const response = await fetch(broker.url, {
		method: "POST",
		headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" },
		body: JSON.stringify(request),
		signal: controller.signal,
	});
	if (!response.ok) throw new Error(`Native graph host failed (${response.status}): ${await response.text()}`);
	const result = (await response.json()) as { exitCode: number };
	if (result.exitCode !== 0) throw new Error(`Native graph host failed (${result.exitCode})`);
	if (!(await Bun.file(request.output).exists()))
		throw new Error("Native graph host did not publish discovery evidence");
	process.exit(0);
}

async function writeIfChanged(filename: string, content: string): Promise<void> {
	const file = Bun.file(filename);
	if ((await file.exists()) && (await file.text()) === content) return;
	await Bun.write(filename, content);
}

// The outer repository has already resolved and watched cycles.json. Materialize
// only native graph declarations here; no Bun build or source scan is repeated.
const graph = ['package(default_visibility = ["//visibility:public"])'];
for (const [directory, dependencies] of Object.entries(request.packageDeps)) {
	const name = path.posix.basename(directory);
	graph.push(
		`filegroup(name = ${JSON.stringify(`pkg_${name}`)}, srcs = ${JSON.stringify(dependencies.map(dependency => `:pkg_${path.posix.basename(dependency)}`))})`,
	);
}
for (const [name, dependencies] of Object.entries(request.graph.deps)) {
	graph.push(
		`filegroup(name = ${JSON.stringify(name)}, srcs = ${JSON.stringify(
			dependencies.filter(dependency => dependency in request.graph.deps).map(dependency => `:${dependency}`),
		)})`,
	);
}
// The parent's resolved platforms module is the genuine module, including its
// version, dependencies and host-platform extension. Read it in place, without
// copying repository contents. Declaration bootstrap separately seeds a missing
// graph lockfile with native Bazel 9.2.0 registry hashes for implicit bazel_tools
// dependencies; native --lockfile_mode=update owns subsequent lockfile changes.
await writeIfChanged(
	path.join(request.workspace, "MODULE.bazel"),
	[
		'module(name = "omp_gate_graph")',
		'bazel_dep(name = "platforms")',
		`local_path_override(module_name = "platforms", path = ${JSON.stringify(request.platformsRoot)})`,
		"",
	].join("\n"),
);
await writeIfChanged(path.join(request.workspace, ".bazelversion"), "9.2.0\n");
await writeIfChanged(path.join(request.workspace, "graph", "BUILD.bazel"), `${graph.join("\n")}\n`);
// Literal workspace-relative output symlinks only; graph/ and the genuine
// platforms repository remain available to native package discovery.
await writeIfChanged(
	path.join(request.workspace, ".bazelignore"),
	"bazel-bin\nbazel-out\nbazel-testlogs\nbazel-graph-workspace\n",
);

// Keep the graph server and its analysis state across successful gate runs.
// This output base is independent of the parent's repository-fetch lock.
// Cancellation belongs to the active native client, never a shared server.
const sessionArgs = [
	request.bazel,
	`--output_base=${request.workspace}-output`,
	"--nosystem_rc",
	"--nohome_rc",
	"--noworkspace_rc",
	`--bazelrc=${path.join(path.dirname(request.workspace), ".bazelrc")}`,
];
let interrupted = false;
let activeQuery: Bun.Subprocess | undefined;
let activeQueryReady = false;
const cancelQuery = () => {
	interrupted = true;
	if (activeQuery && activeQueryReady) {
		try {
			activeQuery.send("abort");
		} catch {
			// A just-exited guardian has already closed its native client.
		}
	}
};
process.on("SIGINT", cancelQuery);
process.on("SIGTERM", cancelQuery);
process.on("message", message => {
	if (message === "abort") cancelQuery();
});
process.on("disconnect", cancelQuery);
if (!process.connected) cancelQuery();
else process.send?.({ type: "graph-host-ready" });

async function queryLabels(query: string, filename: string): Promise<string[]> {
	if (interrupted) throw new Error("Native Bazel discovery interrupted");
	const queryFile = `${filename}.query`;
	await Bun.write(queryFile, query);
	const labelsFile = `${queryFile}.labels`;
	// Each native allpaths query shares this session's loaded graph.
	const argv = [
		...sessionArgs,
		"query",
		`--query_file=${queryFile}`,
		`--profile=${queryFile}.profile.gz`,
		"--output=label",
		`--output_file=${labelsFile}`,
		"--noimplicit_deps",
		"--lockfile_mode=update",
		"--incompatible_autoload_externally=",
	];
	process.send?.({ type: "graph-query-profile", profile: `${queryFile}.profile.gz` });
	// Keep a separate client guardian: helper IPC closure requests cancellation
	// of that client, not shutdown of the persistent shared graph server.
	activeQueryReady = false;
	const child = Bun.spawn([process.execPath, import.meta.path, "--native-query-client", JSON.stringify(argv)], {
		cwd: request.workspace,
		// Preserve the host's batches declaration through the query guardian.
		env: { ...process.env },
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
		detached: true,
		onDisconnect: () => relay?.disconnect(),
		ipc(message) {
			if (relay?.(message)) return;
			if (message && typeof message === "object" && "type" in message && message.type === "graph-query-ready") {
				activeQueryReady = true;
				if (interrupted) cancelQuery();
			}
		},
	});
	const relay = relayPersistentBazel(child);
	activeQuery = child;
	if (interrupted) cancelQuery();
	let code: number;
	try {
		code = await child.exited;
	} finally {
		activeQuery = undefined;
		activeQueryReady = false;
	}
	if (code !== 0) throw new Error(`Native Bazel query failed (${code}): ${queryFile}`);
	if (interrupted) throw new Error("Native Bazel discovery interrupted");
	const text = await Bun.file(labelsFile).text();
	return text
		.trim()
		.split(/\r?\n/)
		.filter(Boolean)
		.map(label => label.slice(label.indexOf(":") + 1))
		.sort();
}

async function discover(): Promise<{ packages: string[]; modules: string[][] }> {
	const cyclic = await queryLabels(request.query, request.output);
	const packages = cyclic.filter(name => name.startsWith("pkg_"));
	const remaining = new Set(cyclic.filter(name => !name.startsWith("pkg_")));
	const modules: string[][] = [];
	while (remaining.size) {
		const seed = remaining.values().next().value!;
		// Native allpaths determines each independent strongly connected domain.
		const members = await queryLabels(
			`allpaths("//graph:${seed}", "//graph:${seed}")`,
			`${request.output}.domain-${modules.length}`,
		);
		if (!members.includes(seed)) throw new Error(`Missing native cyclic-domain evidence: ${seed}`);
		modules.push(members);
		for (const name of members) remaining.delete(name);
	}
	modules.sort((left, right) => left[0]!.localeCompare(right[0]!));
	return { packages, modules };
}

// A failed native query propagates without publishing partial discovery.
await Bun.write(request.output, JSON.stringify(await discover()));
process.exit(0);
