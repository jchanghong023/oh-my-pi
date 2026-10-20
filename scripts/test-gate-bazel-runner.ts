import * as fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { BazelPrimitiveSpec } from "./test-gate-bazel";
import type { PersistentBazelClient } from "./test-gate-process";
import { withChargedActivity } from "./test-gate-events";
import { gateClockNanoseconds } from "./test-gate-clock";

interface GateContext {
	eventFile?: string;
	eventToken?: string;
	clockToken?: string;
	reportDirectory?: string;
	graphBroker?: { url: string; token: string };
	nativeBroker?: { url: string; token: string };
	runnerPid?: number;
}

interface BazelTarget {
	label: string;
	test: boolean;
}

interface HostedNativeRequest {
	id: string;
	argv: string[];
	cwd: string;
	env: Record<string, string>;
}

interface BazelBatch {
	argv: string[];
	charged: boolean;
	priority: number;
	reason: string;
	bep: string;
	script?: string;
	targets: BazelTarget[];
}

interface BazelEvidence {
	id?: { targetCompleted?: { label?: string }; testSummary?: { label?: string } };
	completed?: { success?: boolean };
	testSummary?: { overallStatus?: string };
	finished?: {
		overallSuccess?: boolean;
	};
}

function verifyTargets(events: BazelEvidence[], targets: BazelTarget[]): number {
	for (const target of targets) {
		const complete = events.some(
			event => event.id?.targetCompleted?.label === target.label && event.completed?.success === true,
		);
		const passed =
			!target.test ||
			events.some(
				event => event.id?.testSummary?.label === target.label && event.testSummary?.overallStatus === "PASSED",
			);
		if (!complete || !passed) {
			console.error(`Required Bazel result is missing or unsuccessful: ${target.label}`);
			return 1;
		}
	}
	return 0;
}

/** Only the live gate channel is runtime state. Bazel owns target readiness,
 * scheduling, dependency digests, successful results, and test artifacts. */
async function launch(contextFile: string, requestFile: string): Promise<number> {
	let active: PersistentBazelClient | undefined;
	let cancelled = false;
	let closing = false;
	let succeeded = false;
	const graphChildren = new Set<Bun.Subprocess>();
	const graphOperations = new Set<Promise<Response>>();
	const graphProfiles = new Set<string>();
	const hostedBuildEvents = new Set<string>();
	const hostedClients = new Map<string, { client?: PersistentBazelClient; cancelled: boolean }>();
	const abort = () => {
		cancelled = true;
		for (const child of graphChildren) {
			try {
				child.send("abort");
			} catch {}
		}
		for (const entry of hostedClients.values()) {
			entry.cancelled = true;
			void entry.client?.cancel().catch(error => console.error("Hosted native cancellation failed:", error));
		}
		void active?.cancel().catch(error => console.error(error));
	};
	process.on("message", message => {
		if (message === "abort") abort();
	});
	process.on("disconnect", abort);
	process.on("SIGINT", abort);
	process.on("SIGTERM", abort);
	if (!process.connected) abort();
	else process.send?.({ type: "persistent-bazel-ready" });
	// These host-only modules are absent from native primitive runfiles.
	// Static loading would break action execution and add report data to inputs.
	const { requestPersistentBazel, relayPersistentBazel } = await import("./test-gate-process");
	// Only runtime descendants receive this capability; it is never a Bazel input.
	process.env.OMP_GATE_NATIVE_DECLARATION = path.resolve(requestFile);
	const validateHosted = async (value: unknown) => {
		if (!value || typeof value !== "object") throw new Error("Invalid native request");
		const message = value as HostedNativeRequest;
		if (
			typeof message.id !== "string" ||
			!/^[a-f0-9-]{36}$/.test(message.id) ||
			!Array.isArray(message.argv) ||
			!message.argv.every(arg => typeof arg === "string") ||
			typeof message.cwd !== "string" ||
			!path.isAbsolute(message.cwd) ||
			!message.env ||
			typeof message.env !== "object" ||
			!Object.values(message.env).every(value => typeof value === "string")
		)
			throw new Error("Invalid native request");
		const declarationFile = message.env.OMP_GATE_NATIVE_DECLARATION;
		if (
			typeof declarationFile !== "string" ||
			!path.isAbsolute(declarationFile) ||
			path.basename(path.dirname(declarationFile)) !== "runs" ||
			!path.basename(declarationFile).endsWith(".batches.json")
		)
			throw new Error("Invalid nested native declaration");
		const workspace = path.dirname(path.dirname(declarationFile));
		if (workspace === process.cwd()) throw new Error("Native host cannot delegate its own declaration");
		const declaration = (await Bun.file(declarationFile).json()) as { batches: BazelBatch[] };
		const outer = (await Bun.file(requestFile).json()) as { batches: BazelBatch[] };
		if (message.argv[0] !== outer.batches[0]?.argv[0]) throw new Error("Invalid nested native executable");
		const outputBase = message.argv.filter(arg => arg.startsWith("--output_base="));
		if (outputBase.length !== 1 || outputBase[0] !== `--output_base=${message.cwd}-output`)
			throw new Error("Invalid nested native output base");
		if (message.cwd === workspace) {
			const matches = declaration.batches.some(
				({ argv }) =>
					argv.every((arg, index) => message.argv[index] === arg) &&
					/^(build|test|run)$/.test(argv.find(arg => !arg.startsWith("-") && arg !== argv[0]) ?? "") &&
					message.argv
						.slice(argv.length)
						.every(arg =>
							/^--(?:local_resources=(?:memory|cpu)=\d+|default_test_resources=(?:memory|cpu)=\d+)$/.test(arg),
						),
			);
			if (!matches) throw new Error("Native invocation differs from nested declaration");
		} else if (message.cwd === path.join(workspace, "graph-workspace")) {
			const argv = message.argv;
			const queryFile = argv[7]?.slice("--query_file=".length);
			const external = path.relative(path.join(`${workspace}-output`, "external"), queryFile ?? "");
			if (
				argv.length !== 14 ||
				argv[2] !== "--nosystem_rc" ||
				argv[3] !== "--nohome_rc" ||
				argv[4] !== "--noworkspace_rc" ||
				argv[5] !== `--bazelrc=${path.join(workspace, ".bazelrc")}` ||
				argv[6] !== "query" ||
				!argv[7]?.startsWith("--query_file=") ||
				!queryFile ||
				!path.isAbsolute(queryFile) ||
				external === ".." ||
				external.startsWith(`..${path.sep}`) ||
				path.isAbsolute(external) ||
				argv[8] !== `--profile=${queryFile}.profile.gz` ||
				argv[9] !== "--output=label" ||
				argv[10] !== `--output_file=${queryFile}.labels` ||
				argv[11] !== "--noimplicit_deps" ||
				argv[12] !== "--lockfile_mode=update" ||
				argv[13] !== "--incompatible_autoload_externally=" ||
				!(await Bun.file(queryFile).exists())
			)
				throw new Error("Invalid nested graph query");
			const graph = (await Bun.file(path.join(path.dirname(queryFile), "graph-request.json")).json()) as {
				bazel: string;
				workspace: string;
				output: string;
				query: string;
			};
			const suffix = queryFile.slice(graph.output.length);
			if (
				graph.bazel !== argv[0] ||
				graph.workspace !== message.cwd ||
				!queryFile.startsWith(graph.output) ||
				!/^(?:\.domain-\d+)?\.query$/.test(suffix) ||
				path.basename(graph.output) !== "cyclic-inputs.json"
			)
				throw new Error("Native query differs from nested graph declaration");
			const query = await Bun.file(queryFile).text();
			if (
				suffix === ".query"
					? query !== graph.query
					: !/^allpaths\("\/\/graph:[^"\r\n]+", "\/\/graph:[^"\r\n]+"\)$/.test(query)
			)
				throw new Error("Native query expression differs from nested graph declaration");
		} else throw new Error("Invalid nested native working directory");
		return message;
	};
	const { recordBazelInvocation } = await import("./test-gate-bazel-report");
	const graphToken = randomUUID();
	const graphBroker = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			const operation = (async () => {
				if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${graphToken}`)
					return new Response("Forbidden", { status: 403 });
				const endpoint = new URL(request.url).pathname;
				if (endpoint === "/native/cancel") {
					const { id } = (await request.json()) as { id?: string };
					const entry = typeof id === "string" ? hostedClients.get(id) : undefined;
					if (entry) {
						entry.cancelled = true;
						await entry.client?.cancel();
					}
					return Response.json({ cancelled: true });
				}
				if (endpoint === "/native") {
					if (cancelled || closing) return new Response("Native host is closing", { status: 409 });
					let message: HostedNativeRequest;
					try {
						message = await validateHosted(await request.json());
					} catch (error) {
						return new Response(String(error), { status: 400 });
					}
					if (cancelled || closing || request.signal.aborted)
						return new Response("Native host is closing", { status: 409 });
					if (hostedClients.has(message.id)) return new Response("Duplicate native request", { status: 409 });
					const entry: { client?: PersistentBazelClient; cancelled: boolean } = { cancelled: false };
					hostedClients.set(message.id, entry);
					const cancel = () => {
						entry.cancelled = true;
						void entry.client
							?.cancel()
							.catch(error => console.error("Hosted native cancellation failed:", error));
					};
					request.signal.addEventListener("abort", cancel, { once: true });
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							const send = (event: object) => {
								if (!entry.cancelled)
									controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
							};
							const lifetime = (async () => {
								try {
									entry.client = await requestPersistentBazel(message.argv, undefined, {
										cwd: message.cwd,
										env: message.env,
									});
									// Only accepted requests that actually obtained a native client
									// contribute evidence. The nested owner writes its metrics before
									// its installer returns; root registration must cross the process
									// boundary without inventing additional required root targets.
									const bep = message.argv
										.find(arg => arg.startsWith("--build_event_json_file="))
										?.slice("--build_event_json_file=".length);
									if (bep) hostedBuildEvents.add(bep);
									else if (message.argv.includes("query")) {
										const profile = message.argv
											.find(arg => arg.startsWith("--profile="))
											?.slice("--profile=".length);
										if (profile) graphProfiles.add(profile);
									}
									if (entry.cancelled || cancelled || closing || request.signal.aborted) {
										entry.cancelled = true;
										await entry.client.cancel();
									} else send({ pid: entry.client.pid });
									const exitCode = await entry.client.exited;
									// Explicit cancel keeps the stream alive for the exit acknowledgment.
									if (!request.signal.aborted) {
										controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ exitCode })}\n`));
										controller.close();
									}
								} catch (error) {
									if (!request.signal.aborted) {
										try {
											controller.enqueue(
												new TextEncoder().encode(`${JSON.stringify({ error: String(error) })}\n`),
											);
											controller.close();
										} catch {}
									}
								} finally {
									request.signal.removeEventListener("abort", cancel);
									hostedClients.delete(message.id);
								}
							})();
							const tracked = lifetime.then(() => new Response());
							graphOperations.add(tracked);
							void tracked.finally(() => graphOperations.delete(tracked));
						},
						cancel,
					});
					return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
				}
				if (endpoint !== "/") return new Response("Not found", { status: 404 });
				if (cancelled || closing) return Response.json({ exitCode: 130 });
				const graph = (await request.json()) as {
					workspace?: unknown;
					bazel?: unknown;
					query?: unknown;
					output?: unknown;
				};
				if (graph.workspace !== path.join(process.cwd(), "graph-workspace"))
					return new Response("Invalid graph workspace", { status: 400 });
				const batches = (await Bun.file(requestFile).json()) as { batches: BazelBatch[] };
				if (graph.bazel !== batches.batches[0]?.argv[0])
					return new Response("Invalid graph executable", { status: 400 });
				const within = (directory: string, filename: string) => {
					const relative = path.relative(directory, filename);
					return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
				};
				const outputBase = `${process.cwd()}-output`;
				if (
					typeof graph.query !== "string" ||
					typeof graph.output !== "string" ||
					path.basename(graph.output) !== "cyclic-inputs.json" ||
					!within(path.join(outputBase, "external"), path.resolve(graph.output))
				)
					return new Response("Invalid graph query output", { status: 400 });
				const declaration = await Bun.file(path.join(path.dirname(graph.output), "graph-request.json")).json();
				if (JSON.stringify(graph) !== JSON.stringify(declaration))
					return new Response("Graph request differs from native repository declaration", { status: 400 });
				const filename = path.join(process.cwd(), "runs", `${randomUUID()}.graph-request.json`);
				await Bun.write(filename, JSON.stringify(graph));
				if (cancelled || closing) return Response.json({ exitCode: 130 });
				const graphOutput = graph.output;
				const child = Bun.spawn(
					[
						process.execPath,
						path.join(import.meta.dir, "test-gate-bazel-discovery.ts"),
						"--host-discovery",
						filename,
					],
					{
						// Bun's default Windows environment omits runtime process.env updates.
						// Forward this runner's batches declaration, never the graph request.
						env: { ...process.env },
						stdin: "ignore",
						stdout: "inherit",
						stderr: "inherit",
						onDisconnect: () => relay?.disconnect(),
						ipc(message: unknown) {
							if (relay?.(message)) return;
							if (!message || typeof message !== "object" || !("type" in message)) return;
							if (message.type === "graph-host-ready") {
								if (cancelled || closing || request.signal.aborted) {
									try {
										child.send("abort");
									} catch {}
								}
								return;
							}
							if (
								message.type !== "graph-query-profile" ||
								!("profile" in message) ||
								typeof message.profile !== "string"
							)
								return;
							const suffix = message.profile.slice(graphOutput.length);
							if (
								message.profile.startsWith(graphOutput) &&
								/^(?:\.domain-\d+)?\.query\.profile\.gz$/.test(suffix)
							)
								graphProfiles.add(message.profile);
						},
					},
				);
				const relay = relayPersistentBazel(child);
				graphChildren.add(child);
				const cancel = () => {
					try {
						child.send("abort");
					} catch {}
				};
				request.signal.addEventListener("abort", cancel, { once: true });
				try {
					if (request.signal.aborted || cancelled) cancel();
					return Response.json({ exitCode: await child.exited });
				} finally {
					request.signal.removeEventListener("abort", cancel);
					graphChildren.delete(child);
				}
			})();
			graphOperations.add(operation);
			void operation.finally(() => graphOperations.delete(operation)).catch(() => {});
			return operation;
		},
	});
	try {
		const context: GateContext = {
			runnerPid: process.pid,
			eventFile: process.env.OMP_GATE_EVENT_FILE,
			eventToken: process.env.OMP_GATE_EVENT_TOKEN,
			clockToken: process.env.OMP_GATE_CLOCK_TOKEN,
			reportDirectory: process.env.OMP_TEST_REPORT_DIR,
			graphBroker: { url: graphBroker.url.href, token: graphToken },
			nativeBroker: process.env.OMP_GATE_NATIVE_BROKER
				? JSON.parse(process.env.OMP_GATE_NATIVE_BROKER)
				: { url: graphBroker.url.href, token: graphToken },
		};
		await withChargedActivity(() => Bun.write(contextFile, JSON.stringify(context)));
		const request = (await withChargedActivity(async () => await Bun.file(requestFile).json())) as {
			batches: BazelBatch[];
		};
		const run = async (argv: string[]) => {
			if (cancelled) return 130;
			const outputBase = argv.find(arg => arg.startsWith("--output_base="))?.slice("--output_base=".length);
			if (!outputBase) throw new Error("Native Bazel requires an explicit output base");
			const value = (prefix: string) => argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? "";
			const pid = async () => {
				try {
					const result = Number(
						(await fs.readFile(path.join(outputBase, "server", "server.pid.txt"), "utf8")).trim(),
					);
					return Number.isSafeInteger(result) && result > 0 ? result : null;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
					throw error;
				}
			};
			let startedNs = gateClockNanoseconds();
			const serverPidBefore = await pid();
			// Two independent Bazel lanes share this host. Split currently free
			// memory after reserving 2 GiB for JVM growth/analysis and the host;
			// neither lane may independently promise all remaining memory.
			// Process-heavy tests own child runtimes as well as their Bun runner.
			// Reserve two CPUs and 1 GiB per test, leaving two host CPUs outside
			// the combined lane budgets. These are admission options, not inputs.
			// These are estimates, not hard process limits. Bazel 9.2 defaults to
			// allowing one over-budget action when its requested resource is idle;
			// even the 1 MiB low-memory floor therefore permits serial progress.
			const memory = Math.max(1, Math.floor((os.freemem() / 1024 ** 2 - 2048) / 2));
			const cpus = Math.max(1, Math.floor((os.availableParallelism() - 2) / 2));
			const nativeArgv = [
				...argv,
				`--local_resources=memory=${memory}`,
				`--local_resources=cpu=${cpus}`,
				"--default_test_resources=memory=1024",
				"--default_test_resources=cpu=2",
			];
			let exitCode = 1;
			try {
				if (cancelled) return 130;
				startedNs = gateClockNanoseconds();
				active = await requestPersistentBazel(nativeArgv);
				if (cancelled) await active.cancel();
				exitCode = await active.exited;
				return cancelled ? 130 : exitCode;
			} finally {
				active = undefined;
				const finishedNs = gateClockNanoseconds();
				try {
					const recording = recordBazelInvocation({
						label: argv.find(arg => /^(build|test|run|query)$/.test(arg)) ?? "bazel",
						argv: nativeArgv,
						cwd: process.cwd(),
						outputBase,
						startedNs,
						finishedNs,
						serverPidBefore,
						serverPidAfter: await pid(),
						bep: value("--build_event_json_file="),
						profile: value("--profile="),
						execution: value("--execution_log_compact_file="),
						explain: value("--explain="),
						exitCode,
					});
					if (exitCode === 0 && !cancelled) await recording;
					else void recording.catch(error => console.error(error));
				} catch (error) {
					// Evidence failure must never replace the native command's first failure.
					if (exitCode === 0 && !cancelled) throw error;
					console.error(error);
				}
			}
		};
		// Sequential risk bands share one native server; cancellation belongs to
		// the active client, not the persistent server or another agent's command.
		for (const batch of request.batches) {
			console.log(
				`bazel dispatch priority=${batch.priority} reason=${JSON.stringify(batch.reason)} targets=${batch.targets.map(target => target.label).join(",")}`,
			);
			const code = batch.charged ? await withChargedActivity(() => run(batch.argv)) : await run(batch.argv);
			if (code !== 0) return code;
			// A zero client exit is insufficient: do not start a lower-risk band
			// unless every required native action/test has successful BEP evidence.
			const evidenceCode = await withChargedActivity(async () => {
				const events = Bun.JSONL.parse(await Bun.file(batch.bep).text()) as BazelEvidence[];
				if (!events.some(event => event.finished?.overallSuccess === true)) return 1;
				return verifyTargets(events, batch.targets);
			});
			if (evidenceCode !== 0) return evidenceCode;
			const script = batch.script;
			if (script) {
				// Native --script_path preserves Bazel's argv/env/cwd. Run its payload
				// under the ordinary Job/subreaper, never the persistent server owner.
				// This includes setsid/detached descendants that a client signal misses.
				active = await requestPersistentBazel(
					process.platform === "win32" ? [process.env.COMSPEC ?? "cmd.exe", "/d", "/c", script] : [script],
					{ charged: batch.charged },
				);
				if (cancelled) await active.cancel();
				const exitCode = await active.exited;
				active = undefined;
				if (exitCode !== 0) return exitCode;
			}
		}
		succeeded = true;
		return 0;
	} finally {
		closing = true;
		for (const child of graphChildren) {
			try {
				child.send("abort");
			} catch {}
		}
		await Promise.allSettled(
			[...hostedClients.values()].map(entry => {
				entry.cancelled = true;
				return entry.client?.cancel();
			}),
		);
		await Promise.allSettled(graphOperations);
		await graphBroker.stop(true);
		if (succeeded && !cancelled)
			await Bun.write(
				`${requestFile}.invocation-evidence.json`,
				JSON.stringify({
					queryProfiles: [...graphProfiles],
					hostedBuildEvents: [...hostedBuildEvents],
				}),
			);
	}
}

async function primitiveEnvironment(
	spec: BazelPrimitiveSpec,
): Promise<{ env: Record<string, string | undefined>; context: GateContext }> {
	const context = (await Bun.file(path.join(spec.workspace, "context.json")).json()) as GateContext;
	const env: Record<string, string | undefined> = { ...process.env };
	for (const [key, value] of Object.entries(spec.env)) {
		if (process.platform === "win32") {
			for (const existing of Object.keys(env)) {
				if (existing !== key && existing.toUpperCase() === key.toUpperCase()) delete env[existing];
			}
		}
		if (value === null) delete env[key];
		else env[key] = value;
	}
	if (spec.isolated) {
		const temporary =
			process.env.TEST_TMPDIR ?? (await fs.mkdtemp(path.join(process.env.TEMP ?? "/tmp", "omp-bazel-home-")));
		const home = path.join(temporary, "home");
		await fs.mkdir(home, { recursive: true });
		env.HOME = home;
		env.USERPROFILE = home;
		env.OMP_CONFIG_ROOT = "";
		env.PI_CODING_AGENT_DIR = "";
		env.PI_CONFIG_DIR = "";
		for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = "";
	}
	if (process.env.TEST_UNDECLARED_OUTPUTS_DIR) {
		env.OMP_TEST_REPORT_DIR = process.env.TEST_UNDECLARED_OUTPUTS_DIR;
		env.OMP_TEST_RUN_ID = process.env.TEST_TARGET;
	} else if (context.reportDirectory) env.OMP_TEST_REPORT_DIR = context.reportDirectory;
	env.OMP_GATE_EVENT_FILE = context.eventFile;
	env.OMP_GATE_EVENT_TOKEN = context.eventToken;
	env.OMP_GATE_CLOCK_TOKEN = spec.charged ? "" : context.clockToken;
	if (context.nativeBroker) env.OMP_GATE_NATIVE_BROKER = JSON.stringify(context.nativeBroker);
	return { env, context };
}

async function execute(specFile: string, output?: string): Promise<number> {
	const spec = (await Bun.file(specFile).json()) as BazelPrimitiveSpec;
	const { env, context } = await primitiveEnvironment(spec);
	let argv = spec.argv;
	let artifactDirectory: string | undefined;
	if (spec.artifactFiles?.length) {
		if (!output?.endsWith(".success.json")) throw new Error(`Missing Bazel artifact output: ${spec.label}`);
		artifactDirectory = path.resolve(`${output.slice(0, -".success.json".length)}.artifacts`);
		await fs.mkdir(artifactDirectory, { recursive: true });
		argv = [...argv, `--output-dir=${artifactDirectory}`];
	}
	const child = Bun.spawn(argv, { cwd: spec.cwd, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
	const code = await child.exited;
	if (code !== 0 && context.eventFile && context.eventToken) {
		appendFileSync(
			context.eventFile,
			`OMP_GATE_EVENT ${context.eventToken} ${JSON.stringify({ id: randomUUID(), kind: "failure", status: "FAIL", exitCode: code, message: `${spec.label} failed` })}\n`,
		);
	}
	if (code === 0 && artifactDirectory) {
		for (const filename of spec.artifactFiles ?? []) {
			const artifact = path.join(artifactDirectory, filename);
			const stat = await fs.stat(artifact);
			if (!stat.isFile() || stat.size === 0) throw new Error(`Missing real Bazel artifact: ${artifact}`);
		}
	}
	if (code === 0 && output) await Bun.write(output, JSON.stringify({ label: spec.label }));
	return code;
}

// Bun tests run in the existing entry process. Do not add an intermediary
// process: deep launch ancestry changes process-snapshot test environments.
if (!import.meta.main && process.env.OMP_GATE_SPEC) {
	const specFile = process.env.OMP_GATE_SPEC;
	delete process.env.OMP_GATE_SPEC;
	const { env } = await primitiveEnvironment((await Bun.file(specFile).json()) as BazelPrimitiveSpec);
	for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
} else if (import.meta.main) {
	try {
		const [mode, first, ...rest] = process.argv.slice(2);
		if (!first) throw new Error("Expected bazel <context> <batches> or execute <spec> [output]");
		process.exitCode =
			mode === "bazel" ? await launch(first, rest[0]!) : mode === "execute" ? await execute(first, rest[0]) : 2;
	} catch (error) {
		console.error(error);
		process.exitCode = 1;
	} finally {
		if (process.argv[2] === "bazel") process.disconnect?.();
	}
}
