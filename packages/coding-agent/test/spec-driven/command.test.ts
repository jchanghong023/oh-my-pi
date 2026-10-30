import { describe, expect, it, mock, spyOn } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "../../src/async/job-manager";
import { getSpecDrivenController } from "../../src/spec-driven/controller";
import type { SpecDrivenPhase } from "../../src/spec-driven/stages";
import {
	assertDevCommandAllowed,
	assertDevModeActivationAllowed,
	BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS,
	isDevSessionTransitionCommand,
} from "../../src/slash-commands/builtin-spec-driven";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "../../src/slash-commands/types";

function fixture() {
	const jobs = new AsyncJobManager({});
	const output: string[] = [];
	const sessionManager = { buildSessionContext: () => ({ mode: "chat" }), getCwd: () => "/fixture" };
	const select = mock(async (): Promise<string | undefined> => undefined);
	const host = {
		sessionManager,
		cwd: "/fixture",
		settings: {},
		session: {
			asyncJobManager: jobs,
			sessionManager,
			sessionGeneration: 0,
			isDisposed: false,
			getAgentId: () => "owner",
			addDisposer() {},
			registerSessionChangeCallback: () => () => {},
			subscribe: () => () => {},
			hasPendingAsyncWork: () => false,
			getAsyncJobTree: () => null,
			isBusyForSnapshot: false,
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			getPlanModeState: () => undefined,
			getGoalModeState: () => undefined,
			getVibeModeState: () => undefined,
		},
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands() {},
		reloadPlugins: async () => {},
		ui: { select, confirm: async () => true },
	} as unknown as SlashCommandRuntime;
	const controller = getSpecDrivenController(host);
	let mode: "chat" | "dev" = "chat";
	let phase: SpecDrivenPhase = "idle";
	let useTeam = false;
	let frozen = false;
	let native = true;
	const spies: { mockRestore(): void }[] = [
		spyOn(controller, "inputMode").mockImplementation(() => mode),
		spyOn(controller, "status").mockImplementation(() => ({ phase, generation: 0, useTeam })),
		spyOn(controller, "actions").mockImplementation(() => [
			{
				id: "config",
				label: "Team",
				command: "/dev config",
				available: !frozen,
				blockedReason: frozen ? "方案已开始，Team 已冻结" : undefined,
			},
		]),
		spyOn(controller, "nativeSession").mockImplementation(() => (native ? host.session : undefined)),
	];
	const enter = spyOn(controller, "enter").mockImplementation(async () => {
		mode = "dev";
	});
	const exit = spyOn(controller, "exit").mockImplementation(async () => {
		mode = "chat";
	});
	const start = spyOn(controller, "new").mockImplementation(async () => {});
	const next = spyOn(controller, "next").mockImplementation(async () => {});
	const back = spyOn(controller, "back").mockImplementation(async () => {});
	const drop = spyOn(controller, "drop").mockImplementation(async () => {});
	const setTeam = spyOn(controller, "setTeam").mockImplementation(async value => {
		useTeam = value;
	});
	spies.push(enter, exit, start, next, back, drop, setTeam);
	const invoke = (args: string, text = args ? `/dev ${args}` : "/dev") =>
		BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS[0]!.handle!({ name: "dev", args, text }, host);
	return {
		host,
		output,
		controller,
		enter,
		exit,
		start,
		next,
		back,
		drop,
		setTeam,
		invoke,
		select,
		phase: (value: SpecDrivenPhase) => {
			phase = value;
		},
		freeze: () => {
			frozen = true;
		},
		team: () => useTeam,
		native: (value: boolean) => {
			native = value;
		},
		async dispose() {
			for (const spy of spies) spy.mockRestore();
			await controller.dispose();
			await jobs.dispose();
		},
	};
}

describe("/dev six-entry boundary", () => {
	it("requires explicit entry for every subcommand, including new", async () => {
		const f = fixture();
		try {
			for (const args of ["config", "new 完整需求", "next", "back", "drop"]) {
				expect(await f.invoke(args)).toMatchObject({ failed: true, errorCode: "invalid_params" });
			}
			expect(f.enter).not.toHaveBeenCalled();
			expect(f.start).not.toHaveBeenCalled();
			expect(f.next).not.toHaveBeenCalled();
			expect(f.back).not.toHaveBeenCalled();
			expect(f.drop).not.toHaveBeenCalled();
			expect(f.setTeam).not.toHaveBeenCalled();
			expect(f.select).not.toHaveBeenCalled();
			await f.invoke("");
			await f.invoke("");
			expect(f.enter).toHaveBeenCalledTimes(1);
			expect(f.exit).toHaveBeenCalledTimes(1);
		} finally {
			await f.dispose();
		}
	});

	it("rejects unknown and removed entries without compatibility dispatch", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			for (const args of [
				"help",
				"start",
				"start change request",
				"status",
				"answer",
				"confirm-spec",
				"choose",
				"confirm-plan",
				"revise-plan",
				"accept",
				"repair",
				"amend",
				"change-solution",
				"cancel-message",
				"pause",
				"resume",
				"cancel",
				"unknown-review-command",
			]) {
				expect(await f.invoke(args)).toMatchObject({ failed: true, errorCode: "invalid_params" });
			}
			expect(f.start).not.toHaveBeenCalled();
			expect(f.next).not.toHaveBeenCalled();
			expect(f.back).not.toHaveBeenCalled();
			expect(f.drop).not.toHaveBeenCalled();
			expect(f.setTeam).not.toHaveBeenCalled();
			expect(f.select).not.toHaveBeenCalled();
			expect(f.exit).not.toHaveBeenCalled();
		} finally {
			await f.dispose();
		}
	});

	it("rejects missing and surplus arguments before any partial operation", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			for (const args of ["new", "new   ", "config extra", "back extra", "drop extra", "next pure normalizer"]) {
				expect(await f.invoke(args)).toMatchObject({ failed: true, errorCode: "invalid_params" });
			}
			expect(f.start).not.toHaveBeenCalled();
			expect(f.next).not.toHaveBeenCalled();
			expect(f.setTeam).not.toHaveBeenCalled();
			expect(f.back).not.toHaveBeenCalled();
			expect(f.drop).not.toHaveBeenCalled();
			expect(f.select).not.toHaveBeenCalled();
			expect(f.exit).not.toHaveBeenCalled();
		} finally {
			await f.dispose();
		}
	});

	it("extracts multiline requirements from raw command text without treating prose as approval", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			const images: ImageContent[] = [{ type: "image", data: "image", mimeType: "image/png" }];
			const imageLinks = ["image.png"];
			f.host.input = { images, imageLinks };
			await f.invoke("new 我同意 保留格式与 [Image #1]", "/dev \tnew\n我同意\n  保留格式与 [Image #1]  ");
			expect(f.start).toHaveBeenCalledWith("我同意\n  保留格式与 [Image #1]  ", images, imageLinks);
			expect(f.next).not.toHaveBeenCalled();
		} finally {
			await f.dispose();
		}
	});

	it("rejects candidate IDs outside solution without advancing", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			for (const phase of ["idle", "requirements", "planning", "executing"] as const) {
				f.phase(phase);
				expect(await f.invoke("next candidate")).toMatchObject({ failed: true, errorCode: "invalid_params" });
			}
			expect(f.next).not.toHaveBeenCalled();
		} finally {
			await f.dispose();
		}
	});

	it("uses only native Team select; cancellation does not save and frozen config only explains", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			await f.invoke("config");
			expect(f.setTeam).not.toHaveBeenCalled();
			f.select.mockResolvedValueOnce("开启");
			await f.invoke("config");
			expect(f.team()).toBe(true);
			f.select.mockResolvedValueOnce("关闭");
			await f.invoke("config");
			expect(f.team()).toBe(false);
			f.freeze();
			await f.invoke("config");
			expect(f.select).toHaveBeenCalledTimes(3);
			expect(f.output.at(-1)).toContain("冻结");
		} finally {
			await f.dispose();
		}
	});

	it("reports config save failure without claiming a saved choice", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			f.select.mockResolvedValueOnce("开启");
			f.setTeam.mockRejectedValueOnce(new Error("state write failed"));
			expect(await f.invoke("config")).toMatchObject({ failed: true, errorCode: "execution_failed" });
			expect(f.team()).toBe(false);
			expect(f.output.at(-1)).toContain("state write failed");
		} finally {
			await f.dispose();
		}
	});

	it("restores a detached failed new submission and its attachments without erasing a newer draft", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			f.start.mockRejectedValueOnce(new Error("cannot create change"));
			let draft = "newer draft";
			const images: ImageContent[] = [{ type: "image", data: "image", mimeType: "image/png" }];
			const editor = {
				pendingImages: [] as ImageContent[],
				pendingImageLinks: [] as (string | undefined)[],
				imageLinks: [] as (string | undefined)[],
				getExpandedText: () => draft,
				setCollapsedText: (text: string) => {
					draft = text;
				},
				setText: mock((text: string) => {
					draft = text;
				}),
			};
			const runtime = {
				draftDetached: true,
				input: { images, imageLinks: ["image.png"] },
				ctx: {
					session: f.host.session,
					sessionManager: { ...f.host.sessionManager, getCwd: () => "/fixture" },
					settings: f.host.settings,
					editor,
					showDevCommandStatus: (text: string) => {
						f.output.push(text);
					},
					bindMainSession: async () => {},
					showHookSelector: f.select,
					showHookConfirm: async () => true,
					assertCanActivateMode() {},
					refreshSlashCommandState() {},
				},
			} as unknown as TuiSlashCommandRuntime;
			// Retain the actual manager identity used to find the existing workspace owner.
			runtime.ctx.sessionManager = f.host.sessionManager;
			Object.assign(f.host.sessionManager, { getCwd: () => "/fixture" });
			const text = "/dev new request [Image #1]";
			expect(
				await BUILTIN_SPEC_DRIVEN_SLASH_COMMANDS[0]!.handleTui!(
					{ name: "dev", args: "new request [Image #1]", text },
					runtime,
				),
			).toMatchObject({ failed: true });
			expect(draft).toBe(`${text}\n\nnewer draft`);
			expect(editor.pendingImages).toEqual(images);
			expect(editor.pendingImageLinks).toEqual(["image.png"]);
			expect(editor.setText).not.toHaveBeenCalled();
		} finally {
			await f.dispose();
		}
	});

	it("rejects model-generating native commands when Dev has no visible stage", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			f.native(false);
			for (const name of [
				"compact",
				"retry",
				"retryTurn",
				"compactSession",
				"sendQueuedNow",
				"editUserQuery",
				"setAutoDrain",
			]) {
				expect(() => assertDevCommandAllowed(f.host.session, name)).toThrow("不会调用普通会话模型");
			}
			for (const name of ["status", "settings", "help", "stop", "new"]) {
				expect(() => assertDevCommandAllowed(f.host.session, name)).not.toThrow();
			}
		} finally {
			await f.dispose();
		}
	});

	it("permits native safe operations and lifecycle exit routing, with Goal restricted to visible executor", async () => {
		const f = fixture();
		try {
			await f.invoke("");
			for (const command of ["model", "switch", "compact", "retry", "stop", "settings"])
				expect(() => assertDevCommandAllowed(f.host.session, command)).not.toThrow();
			for (const command of ["new", "resume", "fork", "delete", "move", "cwd", "worktree"]) {
				expect(isDevSessionTransitionCommand(command)).toBe(true);
				expect(() => assertDevCommandAllowed(f.host.session, command)).not.toThrow();
			}
			expect(isDevSessionTransitionCommand("session", "delete")).toBe(true);
			expect(isDevSessionTransitionCommand("switch")).toBe(false);
			expect(() => assertDevCommandAllowed(f.host.session, "unknown")).toThrow();
			expect(() => assertDevModeActivationAllowed(f.host.session, "goal")).toThrow();
			f.phase("executing");
			expect(() => assertDevCommandAllowed(f.host.session, "goal")).not.toThrow();
			expect(() => assertDevModeActivationAllowed(f.host.session, "goal")).not.toThrow();
			expect(() => assertDevModeActivationAllowed(f.host.session, "dev")).not.toThrow();
		} finally {
			await f.dispose();
		}
	});
});
