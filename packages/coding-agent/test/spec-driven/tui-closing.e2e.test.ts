import { expect, test } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IMPLEMENTATION, IMPLEMENTATION_PATH, REQUIREMENT, respond } from "./provider-fixture";
import {
	clearNativeDraft,
	entry,
	eventually,
	expectNativeFailure,
	nativeMessageEntries,
	nativeTranscript,
	tuiTest,
	withTui,
} from "./tui-harness";

test.skipIf(!tuiTest)(
	"native archive survives a post-side-effect persistence failure and resumes only closing after restart",
	async () => {
		await withTui({}, [120, 36], async ({ cwd, provider, tui, state, stage, idle, restart }) => {
			await tui("submit", "/dev");
			await idle();
			await tui("submit", `/dev new ${REQUIREMENT}`);
			await stage("requirements");
			await tui("submit", "/dev next");
			await stage("solution");
			await tui("submit", "/dev next pure");
			await stage("planning");
			await tui("submit", "/dev next");
			const executing = (await stage("executing")).run!;
			const calls = provider.requests.length;
			const report = (entry(provider, "executor").outputPaths as string[])[0]!;
			const reportBytes = await fs.readFile(path.join(cwd, report));
			const source = path.join(cwd, `openspec/changes/${executing.changeId}`);
			const archiveRoot = path.join(cwd, "openspec/changes/archive");
			const conflict = path.join(archiveRoot, `${new Date().toISOString().slice(0, 10)}-${executing.changeId}`);
			// First obtain a real durable acceptance without inventing saved fields.
			// This pre-archive conflict is setup, not the partial-success evidence.
			await fs.mkdir(conflict, { recursive: true });
			await tui("submit", "/dev next");
			await expectNativeFailure(tui, /OpenSpec archive failed/);
			await clearNativeDraft(tui, "/dev next");
			const accepted = await state();
			expect(accepted.run?.approvals.executor?.files.length).toBeGreaterThan(0);
			expect(accepted.run?.closing?.synced).not.toBe(true);
			await fs.rmdir(conflict);

			const statePath = path.join(cwd, ".omp/dev/state.json");
			const backup = `${statePath}.closing-recovery-${crypto.randomUUID()}`;
			const sentinelName = `closing-obstruction-${crypto.randomUUID()}`;
			const sentinelPath = path.join(statePath, sentinelName);
			const sentinelContents = "Owned post-archive publication obstruction\n";
			const errors: unknown[] = [];
			let backedUp = false;
			let occupied = false;
			let sentinelCreated = false;
			let release: (() => void) | undefined;
			let archived: string;
			try {
				if (process.platform === "win32") {
					const kernel = dlopen("kernel32.dll", {
						CreateFileW: {
							args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
							returns: FFIType.ptr,
						},
						CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
						GetLastError: { args: [], returns: FFIType.u32 },
					});
					try {
						const name = new Uint16Array([...statePath.split("").map(character => character.charCodeAt(0)), 0]);
						// Share reads/writes but not DELETE: both the initial publish
						// and atomic-file's Windows backup rename must fail.
						const handle = kernel.symbols.CreateFileW(ptr(name), 0x80000000, 3, null, 3, 0x80, null);
						if (!handle || Number(handle) === -1 || Number(handle) === Number(0xffffffffffffffffn))
							throw new Error(
								`Cannot acquire closing publication obstruction: ${kernel.symbols.GetLastError()}`,
							);
						release = () => {
							try {
								if (!kernel.symbols.CloseHandle(handle))
									throw new Error("Cannot release closing publication obstruction");
							} finally {
								kernel.close();
							}
						};
					} catch (error) {
						kernel.close();
						throw error;
					}
				} else {
					await fs.rename(statePath, backup);
					backedUp = true;
					await fs.mkdir(statePath);
					occupied = true;
					await fs.writeFile(sentinelPath, sentinelContents, { flag: "wx" });
					sentinelCreated = true;
				}
				// Acceptance already exists, so this obstacle is reached only when
				// real OpenSpec has returned its archive result and publishes progress.
				await tui("submit", "/dev next");
				await expectNativeFailure(tui, /EBUSY|EISDIR|EPERM|EACCES|ENOTEMPTY|EEXIST/);
				await clearNativeDraft(tui, "/dev next");
				if (sentinelCreated) {
					expect(await fs.readdir(statePath)).toEqual([sentinelName]);
					expect(await fs.readFile(sentinelPath, "utf8")).toBe(sentinelContents);
				}
				const names = await fs.readdir(archiveRoot);
				const matches = names.filter(name => name.endsWith(`-${executing.changeId}`));
				expect(matches).toHaveLength(1);
				archived = `openspec/changes/archive/${matches[0]!}`;
				expect(await Bun.file(path.join(cwd, archived, "proposal.md")).exists()).toBe(true);
				await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
				expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).text()).toContain(REQUIREMENT);
				expect(await Bun.file(backedUp ? backup : statePath).json()).toEqual(accepted);
				expect(provider.requests).toHaveLength(calls);
			} catch (error) {
				errors.push(error);
			} finally {
				try {
					release?.();
				} catch (cleanupError) {
					errors.push(cleanupError);
				}
				try {
					if (sentinelCreated) {
						expect(await fs.readdir(statePath)).toEqual([sentinelName]);
						expect(await fs.readFile(sentinelPath, "utf8")).toBe(sentinelContents);
						await fs.unlink(sentinelPath);
					}
					if (occupied) await fs.rmdir(statePath);
				} catch (cleanupError) {
					errors.push(cleanupError);
				}
				try {
					if (backedUp) await fs.rename(backup, statePath);
				} catch (cleanupError) {
					errors.push(cleanupError);
				}
			}
			if (errors.length === 1) throw errors[0];
			if (errors.length > 1)
				throw new AggregateError(errors, "Native closing and owned obstruction restoration failed");

			await tui("submit", "/dev back");
			await expectNativeFailure(tui, /收尾已产生实际结果，不能回退/);
			await clearNativeDraft(tui, "/dev back");
			// Exit must save the actual in-memory progress despite the earlier
			// persistence error; no fixture writes any progress or archive path.
			await tui("submit", "/dev");
			await tui("expect", "text", "ordinary-root-beacon", "--timeout", "30000");
			const saved = (await state()).run!;
			expect(saved.phase).toBe("executing");
			expect(saved.closing).toMatchObject({ synced: true, archivedChangePath: archived! });
			expect(saved.approvals).toEqual(accepted.run!.approvals);
			expect(provider.requests).toHaveLength(calls);
			const archivedProposal = await fs.readFile(path.join(cwd, archived!, "proposal.md"));
			const mainSpec = await fs.readFile(path.join(cwd, "openspec/specs/greeting/spec.md"));
			const savedSessions = await Promise.all(
				(["requirements", "solution", "planner", "executor"] as const).map(async role => {
					const session = saved.sessions[role]!;
					expect(session.role).toBe(role);
					return {
						role,
						sessionId: session.sessionId,
						sessionFile: session.sessionFile,
						messages: nativeMessageEntries(await nativeTranscript(saved, role)),
					};
				}),
			);
			await restart();
			const restartedCalls = provider.requests.length;
			await tui("submit", "/dev");
			await stage("executing");
			expect((await state()).run?.closing?.archivedChangePath).toBe(archived!);
			await tui("submit", "/dev back");
			await expectNativeFailure(tui, /收尾已产生实际结果，不能回退/);
			await clearNativeDraft(tui, "/dev back");
			await tui("submit", "/dev next");
			const closed = await eventually(state, value => value.run?.phase === "idle");
			await idle();
			expect(closed.run?.archivedChangePath).toBe(archived!);
			expect(Object.keys(closed.run!.sessions).sort()).toEqual(Object.keys(saved.sessions).sort());
			for (const session of savedSessions) {
				expect(closed.run!.sessions[session.role]).toMatchObject({
					role: session.role,
					sessionId: session.sessionId,
					sessionFile: session.sessionFile,
				});
				expect(nativeMessageEntries(await nativeTranscript(closed.run!, session.role))).toEqual(session.messages);
			}
			expect(provider.requests).toHaveLength(restartedCalls);
			await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readdir(archiveRoot)).toEqual([path.basename(archived!)]);
			expect(await fs.readFile(path.join(cwd, archived!, "proposal.md"))).toEqual(archivedProposal);
			expect(await fs.readFile(path.join(cwd, "openspec/specs/greeting/spec.md"))).toEqual(mainSpec);
			await tui("submit", "/dev drop");
			await eventually(state, value => !value.run && !value.team);
			await idle();
			expect(await fs.readFile(path.join(cwd, archived!, "proposal.md"))).toEqual(archivedProposal);
			expect(await fs.readFile(path.join(cwd, "openspec/specs/greeting/spec.md"))).toEqual(mainSpec);
			expect(await fs.readFile(path.join(cwd, report))).toEqual(reportBytes);
			expect(await Bun.file(path.join(cwd, IMPLEMENTATION_PATH)).text()).toBe(IMPLEMENTATION);
			expect(provider.requests).toHaveLength(restartedCalls);
		});
	},
	300_000,
);

const authorityPath = "docs/requirements/product.md";
const oldBehavior = "Greeting behavior is not yet specified.";
const originalAuthority = `# Product requirements\n\n<!-- maintained by the product owner: keep this comment -->\n\n## Greeting\n\n${oldBehavior}\n\n## Unrelated export contract\n\nPreserve CSV delimiters, ordering, and trailing newlines exactly.\n\n[External policy](https://example.invalid/policy)\n`;
const updatedAuthority = originalAuthority.replace(oldBehavior, REQUIREMENT);

test.skipIf(!tuiTest)(
	"native Dev blocks ambiguous Markdown authorities then minimally maintains the existing authority without a shadow main spec",
	async () => {
		await withTui(
			{
				async setup(cwd) {
					await fs.mkdir(path.join(cwd, "docs/requirements"), { recursive: true });
					await Bun.write(path.join(cwd, authorityPath), originalAuthority);
					await fs.mkdir(path.join(cwd, "requirements"));
					await Bun.write(
						path.join(cwd, "requirements/alternative.md"),
						"# Competing authority\n\nDo not guess ownership.\n",
					);
				},
				reply(request) {
					const reply = respond(request);
					if (reply.tool?.name.replace(/^_/u, "") === "write" && reply.tool.args.path === authorityPath)
						return { tool: { ...reply.tool, args: { ...reply.tool.args, content: updatedAuthority } } };
					return reply;
				},
			},
			[120, 36],
			async ({ cwd, provider, tui, state, stage, idle }) => {
				await tui("submit", "/dev");
				await idle();
				const calls = provider.requests.length;
				await tui("submit", `/dev new ${REQUIREMENT}`);
				await expectNativeFailure(tui, /Ambiguous Markdown requirement authorities/);
				await clearNativeDraft(tui, `/dev new ${REQUIREMENT}`);
				expect((await state()).run).toBeUndefined();
				expect(provider.requests).toHaveLength(calls);
				expect(await Bun.file(path.join(cwd, authorityPath)).text()).toBe(originalAuthority);
				expect(await Bun.file(path.join(cwd, "requirements/alternative.md")).text()).toBe(
					"# Competing authority\n\nDo not guess ownership.\n",
				);
				// Discovery treats these as authority roots, not individual files.
				// Remove only the competing fixture, leaving docs/requirements as
				// the existing root whose exact Markdown path must be maintained.
				await fs.unlink(path.join(cwd, "requirements/alternative.md"));
				await fs.rmdir(path.join(cwd, "requirements"));
				await tui("submit", `/dev new ${REQUIREMENT}`);
				const requirements = (await stage("requirements")).run!;
				expect(requirements.paths?.requirements).toContain(authorityPath);
				expect(entry(provider, "requirements").files).toEqual(
					expect.arrayContaining([expect.objectContaining({ path: authorityPath, content: originalAuthority })]),
				);
				expect(await Bun.file(path.join(cwd, authorityPath)).text()).toBe(updatedAuthority);
				await tui("submit", "/dev next");
				await stage("solution");
				await tui("submit", "/dev next pure");
				await stage("planning");
				await tui("submit", "/dev next");
				const executing = (await stage("executing")).run!;
				const beforeClosing = provider.requests.length;
				await tui("submit", "/dev next");
				const closed = await eventually(state, value => !!value.run?.archivedChangePath);
				await idle();
				expect(closed.run?.phase).toBe("idle");
				expect(await Bun.file(path.join(cwd, authorityPath)).text()).toBe(updatedAuthority);
				expect(await fs.readdir(path.join(cwd, "docs/requirements"))).toEqual(["product.md"]);
				// A real native archive of an ADDED delta would create this file
				// without --skip-specs. Its absence proves the Markdown close route.
				expect(await Bun.file(path.join(cwd, "openspec/specs/greeting/spec.md")).exists()).toBe(false);
				expect(
					await fs.readdir(path.join(cwd, "openspec/specs")).catch(error => {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
						throw error;
					}),
				).toEqual([]);
				expect(
					await Bun.file(path.join(cwd, closed.run!.archivedChangePath!, "specs/greeting/spec.md")).exists(),
				).toBe(true);
				await expect(fs.stat(path.join(cwd, `openspec/changes/${executing.changeId}`))).rejects.toMatchObject({
					code: "ENOENT",
				});
				expect(provider.requests).toHaveLength(beforeClosing);
			},
		);
	},
	300_000,
);
