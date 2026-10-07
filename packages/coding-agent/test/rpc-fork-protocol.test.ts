import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

// Fork-surface E2E against the real public entry (`omp --mode rpc-ui`, one
// OMP process per session): the ready frame announces protocol v3, v2 clients
// keep the stock command surface, v3 negotiation unlocks the fork commands
// (rich command catalog, dynamic completion, persisted model roles, and the
// saved-session directory), and EOF exits cleanly. Sessions persist into
// isolated temp dirs; no real model is contacted.

type RpcFrame = Record<string, unknown>;

interface ServerControls {
	readonly closeStdin: () => void;
	readonly exited: Promise<number>;
	readonly send: (frame: object) => void;
}

async function withForkRpcServer<T>(
	dirs: { cwd: string; sessionDir: string; agentDir: string },
	run: (
		next: (predicate?: (frame: RpcFrame) => boolean) => Promise<RpcFrame>,
		seen: readonly RpcFrame[],
		controls: ServerControls,
	) => Promise<T>,
): Promise<T> {
	const child = Bun.spawn(
		[
			"bun",
			path.join(import.meta.dir, "..", "src", "cli.ts"),
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-ui",
			"--no-skills",
			"--no-tools",
			"--session-dir",
			dirs.sessionDir,
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: dirs.cwd,
			env: {
				...Bun.env,
				PI_NO_TITLE: "1",
				PI_CODING_AGENT_DIR: dirs.agentDir,
				// Keep model resolution configured for the restore check and role validation.
				// A persisted test credential below drives the host-owned logout dialog.
				ANTHROPIC_API_KEY: "test-key",
			} as unknown as Record<string, string | undefined>,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderrPromise = new Response(child.stderr).text();
	const seen: RpcFrame[] = [];
	const queue: RpcFrame[] = [];
	let readerDone = false;
	let readerError: unknown;
	const lines = readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>);
	const pump = (async () => {
		try {
			for await (const line of lines) {
				if (isRecord(line)) {
					seen.push(line);
					queue.push(line);
				}
			}
		} catch (error) {
			readerError = error;
		} finally {
			readerDone = true;
		}
	})();
	const next = async (predicate?: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const deadline = Date.now() + 120_000;
		for (;;) {
			const index = predicate ? queue.findIndex(predicate) : queue.length > 0 ? 0 : -1;
			if (index >= 0) return queue.splice(index, 1)[0]!;
			if (readerDone) throw readerError ?? new Error(`RPC stream ended; last stderr: ${await stderrPromise}`);
			if (Date.now() > deadline) throw new Error("Timed out waiting for RPC frame");
			await Bun.sleep(50);
		}
	};
	const controls: ServerControls = {
		send: frame => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
		},
		closeStdin: () => {
			child.stdin.end();
		},
		exited: child.exited,
	};
	try {
		return await run(next, seen, controls);
	} finally {
		controls.closeStdin();
		await Promise.race([child.exited, Bun.sleep(30_000)]);
		if (child.exitCode === null) child.kill();
		await pump.catch(() => {});
	}
}

describe("fork RPC surface over the single-session host (rpc-ui-protocol.md)", () => {
	test("v3 negotiation gates the fork commands on the real rpc-ui entry", async () => {
		await using root = await TempDir.create("rpc-fork-e2e-");
		const cwd = path.resolve(root.join("project"));
		const sessionDir = path.resolve(root.join("sessions"));
		const agentDir = path.resolve(root.join("agent"));
		for (const dir of [cwd, sessionDir, agentDir]) {
			await fs.mkdir(dir, { recursive: true });
		}
		const movedCwd = path.join(cwd, "moved");
		await fs.mkdir(path.join(movedCwd, "destination-only"), { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "modelRoles: {}\n");
		const authStorage = await AuthStorage.create(getAgentDbPath(agentDir));
		try {
			await authStorage.credentials.set("anthropic", { type: "api_key", key: "stored-for-rpc-dialog-test" });
		} finally {
			authStorage.close();
		}
		// One saved session of this project, pre-written so the directory has an
		// entry before the hosted session persists anything.
		const now = new Date().toISOString();
		const savedHeader = { type: "session", version: 2, id: "e2e-saved", timestamp: now, cwd, title: "Saved session" };
		await fs.writeFile(
			path.join(sessionDir, "e2e-saved.jsonl"),
			`${serializeTitleSlot({ title: "Saved session", source: "user", updatedAt: now })}${JSON.stringify(savedHeader)}\n`,
		);

		await withForkRpcServer({ cwd, sessionDir, agentDir }, async (next, _seen, controls) => {
			// Ready announces upstream v1/v2 plus the fork v3 surface.
			const ready = await next(frame => frame.type === "ready");
			expect(ready.supportedProtocolVersions).toEqual([1, 2, 3]);

			// Stock v2 negotiation keeps working and does NOT unlock fork commands.
			controls.send({ id: "n2", type: "negotiate_protocol", protocolVersion: 2 });
			const v2 = await next(frame => frame.type === "response" && frame.id === "n2");
			expect(v2).toMatchObject({ success: true, data: { protocolVersion: 2 } });
			controls.send({ id: "cc0", type: "complete_command", text: "/mo", cursor: 3 });
			const gated = await next(frame => frame.type === "response" && frame.id === "cc0");
			expect(gated.success).toBe(false);

			// v3 negotiation reports the fork capabilities.
			controls.send({ id: "n3", type: "negotiate_protocol", protocolVersion: 3 });
			const v3 = await next(frame => frame.type === "response" && frame.id === "n3");
			expect(v3).toMatchObject({
				success: true,
				data: {
					protocolVersion: 3,
					capabilities: { commandCompletion: true, modelRoleConfig: true, sessionDirectory: true },
				},
			});

			// Rich command catalog: descriptors carry execution verdicts and a revision.
			controls.send({ id: "cat", type: "get_available_commands" });
			const catalog = await next(frame => frame.type === "response" && frame.id === "cat");
			expect(catalog.success).toBe(true);
			const commands = (catalog.data as { commands: RpcFrame[]; revision: string }).commands;
			expect(typeof (catalog.data as Record<string, unknown>).revision).toBe("string");
			const model = commands.find(command => command.name === "model");
			expect(model).toMatchObject({ source: "builtin", execution: "omp", availability: { available: true } });

			// Dynamic completion over the live catalog.
			controls.send({ id: "cc", type: "complete_command", text: "/mo", cursor: 3 });
			const completion = await next(frame => frame.type === "response" && frame.id === "cc");
			expect(completion.success).toBe(true);
			const items = (completion.data as { items: RpcFrame[] }).items;
			expect(items.some(item => item.label === "model" && item.insertText === "/model ")).toBe(true);

			// Model roles: list, then persist a concrete selection with its revision.
			controls.send({ id: "roles1", type: "get_model_roles" });
			const roles1 = await next(frame => frame.type === "response" && frame.id === "roles1");
			expect(roles1.success).toBe(true);
			const roles = (roles1.data as { roles: RpcFrame[] }).roles;
			const defaultRole = roles.find(role => role.roleId === "default")!;
			expect(defaultRole.revision).toStartWith("role-");
			controls.send({
				id: "set1",
				type: "set_model_role",
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "anthropic", modelId: "claude-sonnet-4-5" } },
				expectedRevision: defaultRole.revision,
			});
			const set1 = await next(frame => frame.type === "response" && frame.id === "set1");
			expect(set1.success).toBe(true);
			expect((set1.data as Record<string, unknown>).persisted).toBe(true);
			// A replayed stale revision is refused.
			controls.send({
				id: "set2",
				type: "set_model_role",
				roleId: "default",
				scope: "user",
				selection: null,
				expectedRevision: defaultRole.revision,
			});
			const set2 = await next(frame => frame.type === "response" && frame.id === "set2");
			expect(set2).toMatchObject({ success: false, code: "revision_conflict" });
			// Builtin command dialogs are host-owned RPC UI, still available when
			// extension UI is disabled by --no-ui.
			controls.send({ id: "logout", type: "prompt", message: "/logout anthropic" });
			const logoutDialog = await next(
				frame =>
					(frame.type === "extension_ui_request" && frame.method === "select") || frame.type === "command_output",
			);
			expect(logoutDialog).toMatchObject({
				type: "extension_ui_request",
				method: "select",
				title: expect.stringContaining("Anthropic"),
			});
			expect(logoutDialog.options).toEqual([expect.stringContaining("API key")]);
			controls.send({ type: "extension_ui_response", id: logoutDialog.id as string, cancelled: true });
			const logout = await next(frame => frame.type === "response" && frame.id === "logout");
			expect(logout).toMatchObject({ command: "prompt", success: true });

			// Session directory: a saved session of this project is listed, can be
			// renamed with its revision, and deleted. The hosted session itself
			// persists lazily (nothing is written before its first message), so
			// the directory here holds the pre-written saved session only.
			controls.send({ id: "ls1", type: "list_sessions" });
			const ls1 = await next(frame => frame.type === "response" && frame.id === "ls1");
			const sessions = (ls1.data as { sessions: RpcFrame[] }).sessions;
			expect(sessions.map(session => session.sessionId)).toEqual(["e2e-saved"]);
			const saved = sessions[0]!;
			expect(saved).toMatchObject({ current: false, name: "Saved session" });
			controls.send({
				id: "rn1",
				type: "rename_session",
				sessionId: "e2e-saved",
				name: "e2e-renamed",
				expectedRevision: saved.revision as string,
			});
			const rn1 = await next(frame => frame.type === "response" && frame.id === "rn1");
			expect(rn1.success).toBe(true);
			controls.send({ id: "ls2", type: "list_sessions" });
			const ls2 = await next(frame => frame.type === "response" && frame.id === "ls2");
			const renamedList = (ls2.data as { sessions: RpcFrame[] }).sessions;
			expect(renamedList[0]).toMatchObject({ sessionId: "e2e-saved", name: "e2e-renamed" });
			controls.send({
				id: "del1",
				type: "delete_session",
				sessionId: "e2e-saved",
				expectedRevision: renamedList[0]!.revision as string,
			});
			const del1 = await next(frame => frame.type === "response" && frame.id === "del1");
			expect(del1).toMatchObject({ success: true, data: { deleted: true } });
			// /move changes both the live cwd and its saved-session directory.
			controls.send({ id: "move", type: "prompt", message: `/move ${movedCwd}` });
			expect(await next(frame => frame.type === "response" && frame.id === "move")).toMatchObject({
				success: true,
				data: { agentInvoked: false },
			});
			controls.send({ id: "moved-completion", type: "complete_command", text: "/move dest", cursor: 10 });
			const movedCompletion = await next(frame => frame.type === "response" && frame.id === "moved-completion");
			expect(movedCompletion).toMatchObject({
				success: true,
				data: { items: [{ label: "destination-only/", insertText: "destination-only/" }] },
			});
			controls.send({ id: "moved-state", type: "get_state" });
			const movedState = await next(frame => frame.type === "response" && frame.id === "moved-state");
			if (
				!isRecord(movedState.data) ||
				typeof movedState.data.sessionId !== "string" ||
				typeof movedState.data.sessionFile !== "string"
			) {
				throw new Error("Moved session state lacks its identity or file");
			}
			const movedSessionId = movedState.data.sessionId;
			await fs.writeFile(
				path.join(path.dirname(movedState.data.sessionFile), "moved-saved.jsonl"),
				`${serializeTitleSlot({ title: "Moved saved session", source: "user", updatedAt: now })}${JSON.stringify({ ...savedHeader, id: "moved-saved", cwd: movedCwd })}\n`,
			);
			controls.send({
				id: "moved-rename",
				type: "rename_session",
				sessionId: movedSessionId,
				name: "Moved live session",
			});
			expect(await next(frame => frame.type === "response" && frame.id === "moved-rename")).toMatchObject({
				success: true,
				data: { sessionId: movedSessionId, name: "Moved live session", current: true },
			});
			controls.send({ id: "moved-list", type: "list_sessions" });
			const movedList = await next(frame => frame.type === "response" && frame.id === "moved-list");
			if (!isRecord(movedList.data) || !Array.isArray(movedList.data.sessions)) {
				throw new Error("Moved session listing lacks its sessions");
			}
			expect(movedList.data.sessions).toContainEqual(
				expect.objectContaining({ sessionId: "moved-saved", name: "Moved saved session", current: false }),
			);
			controls.send({ id: "moved-delete", type: "delete_session", sessionId: movedSessionId });
			expect(await next(frame => frame.type === "response" && frame.id === "moved-delete")).toMatchObject({
				success: false,
				code: "unsupported",
			});
			// Renegotiating down to v2 revokes the v3-only command surface.
			controls.send({ id: "n2-again", type: "negotiate_protocol", protocolVersion: 2 });
			expect(await next(frame => frame.type === "response" && frame.id === "n2-again")).toMatchObject({
				success: true,
				data: { protocolVersion: 2 },
			});
			controls.send({ id: "cc-after-downgrade", type: "complete_command", text: "/mo", cursor: 3 });
			expect(await next(frame => frame.type === "response" && frame.id === "cc-after-downgrade")).toMatchObject({
				success: false,
				error: expect.stringContaining("Unknown command"),
			});

			// Unknown commands still report the stock error.
			controls.send({ id: "wat", type: "definitely_not_a_thing" });
			const wat = await next(frame => frame.type === "response" && frame.id === "wat");
			expect(wat).toMatchObject({ success: false, error: expect.stringContaining("Unknown command") });
		});
	}, 300_000);
});
