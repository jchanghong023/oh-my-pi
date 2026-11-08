import { type Component, type OverlayHandle, matchesKey, wrapLiteralLine } from "@oh-my-pi/pi-tui";
import { getActiveProfile, sanitizeText } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import type { SlashCommandResult, WebGuiSlashCommandRuntime } from "../slash-commands/types";
import { TeamConfigError, TeamConfigService } from "./config";
import type { TeamConfigSnapshot, TeamMemberSlot, TeamModelRef } from "./config-types";
import { cfgTeamMembers } from "./settings";

type DraftMember = (TeamModelRef & { originalSelector?: string }) | { rawSelector: string };

function printable(value: unknown): string {
	return sanitizeText(typeof value === "string" ? value : (JSON.stringify(value) ?? "未读取")).replaceAll(
		"\t",
		"    ",
	);
}

/** Configuration only: never dispatches a model call or mutates the session model. */
export function showTeamConfig(ctx: InteractiveModeContext): void {
	new TeamConfigPanel(ctx).open();
}

/** Browser dialogs edit the same ordered draft and revision-checked user setting as the TUI panel. */
export async function showWebGuiTeamConfig(runtime: WebGuiSlashCommandRuntime): Promise<SlashCommandResult> {
	const { session, settings, sessionManager, cwd } = runtime;
	const sessionId = session.sessionId;
	const registry = session.modelRegistry;
	const current = (): boolean =>
		!runtime.signal?.aborted &&
		!session.isDisposed &&
		session.sessionId === sessionId &&
		session.settings === settings &&
		session.modelRegistry === registry &&
		sessionManager.getCwd() === cwd;
	const assertCurrent = (): void => {
		runtime.signal?.throwIfAborted();
		if (!current()) throw new Error("The initiating Team configuration context is no longer current");
	};
	const service = new TeamConfigService({
		getSettings: () => settings,
		getModelRegistry: () => registry,
		isCurrent: current,
	});
	const adopt = (config: TeamConfigSnapshot): DraftMember[] | null =>
		config.userMembers?.map(slot => (slot.model ? { ...slot.model } : { rawSelector: slot.rawSelector })) ?? null;
	const label = (member: DraftMember): string =>
		"rawSelector" in member ? member.rawSelector : `${member.provider}/${member.modelId}`;
	const cancel = async (): Promise<SlashCommandResult> => {
		await runtime.output("Team 配置已取消；未提交保存，不发起讨论。");
		return { consumed: true };
	};
	try {
		assertCurrent();
		let snapshot = await service.getConfig();
		assertCurrent();
		let draft = adopt(snapshot);
		let revision = snapshot.revision;
		let generation = 0;
		for (;;) {
			assertCurrent();
			snapshot = await service.getConfig({ clientRevision: String(++generation), members: draft });
			assertCurrent();
			const preview = snapshot.preview!;
			await runtime.output(
				[
					`Team 用户配置：${settings.getAgentDir()}（有效来源：${snapshot.source ?? "env"}）`,
					`已保存：${snapshot.userMembers === undefined ? "读取失败" : snapshot.userMembers === null ? "继承默认" : snapshot.userMembers.map(slot => slot.rawSelector).join(" → ") || "空列表"}`,
					`有序草稿：${draft === null ? "继承默认" : draft.map(label).join(" → ") || "空列表"}`,
					`有效预览：${preview.effectiveMembers === null ? "配置不可用" : preview.effectiveMembers.map(slot => slot.rawSelector).join(" → ") || "当前会话模型"}`,
					preview.participants.length
						? `独立规划槽位：${preview.participants.map(slot => `${slot.label}: ${slot.model.provider}/${slot.model.modelId}`).join(" → ")}`
						: preview.effectiveMembers?.length === 0
							? "未配置或空列表时使用当前会话模型；至少三个独立规划槽位，重复模型仍为独立代理。"
							: "有效槽位不可用；讨论会按原生预检拒绝，不跳过无效模型。",
					...snapshot.issues.map(issue => `${issue.code}：${issue.message}`),
					...preview.issues.map(issue => `${issue.code}：${issue.message}`),
					...(revision !== snapshot.revision ? ["外部版本已改变；草稿保留，请重读比较后保存。"] : []),
				].join("\n"),
			);
			const action = await runtime.ui.select("Team configure（不调用模型）", [
				"添加模型槽位",
				...(draft?.length ? ["编辑或移动槽位"] : []),
				"清空为当前会话模型",
				"删除用户覆盖（继承）",
				"重读配置",
				"保存",
				"取消",
			]);
			assertCurrent();
			if (action === undefined || action === "取消") return cancel();
			if (action === "重读配置") {
				const fresh = await service.getConfig();
				assertCurrent();
				const discard = await runtime.ui.confirm(
					"重读 Team 配置",
					"放弃当前草稿并采用最新用户值？选择否保留草稿，仅采用新版本供比较。",
				);
				assertCurrent();
				if (discard) draft = adopt(fresh);
				revision = fresh.revision;
				continue;
			}
			if (action === "清空为当前会话模型") {
				draft = [];
				continue;
			}
			if (action === "删除用户覆盖（继承）") {
				draft = null;
				continue;
			}
			if (action === "保存") {
				if (!revision || !snapshot.writableScopes.includes("user")) {
					throw new TeamConfigError("execution_failed", "当前配置不可安全写入，请先修复读取问题并重读。");
				}
				if (revision !== snapshot.revision) {
					await runtime.output("revision_conflict：外部版本已改变；草稿保留，请重读比较后保存。");
					continue;
				}
				if (draft?.some(member => "rawSelector" in member)) {
					await runtime.output("旧槽位尚未解析：请替换或删除后保存。");
					continue;
				}
				if (
					!(await runtime.ui.confirm("保存 Team 配置", "保存有序草稿到此原生配置的用户设置？此操作不调用模型。"))
				) {
					assertCurrent();
					continue;
				}
				assertCurrent();
				const members =
					draft === null
						? null
						: draft.flatMap(member =>
								"rawSelector" in member ? [] : [{ provider: member.provider, modelId: member.modelId }],
							);
				const result = await service.setConfig({ scope: "user", expectedRevision: revision, members });
				await runtime.output(
					`${result.saveState}：${result.effectiveMatchesRequested ? "保存且生效" : "已保存但有效值受高层覆盖"}；${printable(result.write)} ${result.effectiveNote ?? ""}`,
				);
				return { consumed: true };
			}
			let index: number | undefined;
			if (action === "编辑或移动槽位" && draft?.length) {
				const labels = draft.map((member, slot) => `${slot + 1}. ${label(member)}`);
				const selected = await runtime.ui.select("选择有序槽位", labels);
				assertCurrent();
				if (selected === undefined) continue;
				index = labels.indexOf(selected);
				if (index < 0) continue;
				const operation = await runtime.ui.select(`槽位 ${index + 1}`, [
					"替换模型",
					"删除槽位",
					...(index > 0 ? ["上移"] : []),
					...(index + 1 < draft.length ? ["下移"] : []),
				]);
				assertCurrent();
				if (operation === undefined) continue;
				if (operation === "删除槽位") {
					draft.splice(index, 1);
					continue;
				}
				if (operation === "上移" || operation === "下移") {
					const target = index + (operation === "上移" ? -1 : 1);
					[draft[index], draft[target]] = [draft[target]!, draft[index]!];
					continue;
				}
			}
			if (action !== "添加模型槽位" && index === undefined) continue;
			const query = await runtime.ui.input("搜索 Team 模型（留空显示全部）", "provider / model / name");
			assertCurrent();
			if (query === undefined) continue;
			const models = service.getModels(query).models;
			const selectable = models.filter(model => model.selectable);
			if (!selectable.length) {
				await runtime.output(
					[
						"没有可选 Team 模型。",
						...models.map(model => `${model.model.provider}/${model.model.modelId}：${model.reason ?? "不可用"}`),
					].join("\n"),
				);
				continue;
			}
			const options = selectable.map(model => ({
				label: `${model.model.provider}/${model.model.modelId}`,
				description: model.name,
			}));
			const selected = await runtime.ui.select("选择 Team 模型（重复模型保留为独立槽位）", options);
			assertCurrent();
			if (selected === undefined) continue;
			const model = selectable[options.findIndex(option => option.label === selected)]?.model;
			if (!model) continue;
			draft ??= [];
			if (index === undefined) draft.push(model);
			else draft[index] = model;
		}
	} catch (error) {
		await runtime.output(
			error instanceof TeamConfigError
				? `${error.code}：${error.message}${error.data ? `；${printable(error.data)}` : ""}`
				: printable(error instanceof Error ? error.message : error),
		);
		return { consumed: true, failed: true };
	}
}

class TeamConfigPanel implements Component {
	readonly #session;
	readonly #settings;
	readonly #sessionId: string;
	readonly #service: TeamConfigService;
	readonly #profile = getActiveProfile();
	#handle?: OverlayHandle;
	#unsubscribe?: () => void;
	#closed = false;
	#draft: DraftMember[] | null = null;
	#baseline = "null";
	#revision: string | null = null;
	#snapshot?: TeamConfigSnapshot;
	#selected = 0;
	#scroll = 0;
	#followSelection = false;
	#showAdvanced = false;
	#clientRevision = 0;
	#readGeneration = 0;
	#saving = false;
	#confirmDiscard = false;
	#message = "正在读取配置（Esc 可关闭，不等待存储 IO）…";

	constructor(private readonly ctx: InteractiveModeContext) {
		this.#session = ctx.session;
		this.#settings = ctx.settings;
		this.#sessionId = ctx.sessionManager.getSessionId();
		this.#service = new TeamConfigService({
			getSettings: () => this.#settings,
			getModelRegistry: () => this.#session.modelRegistry,
			isCurrent: () => this.#current(),
		});
	}

	#current(): boolean {
		return (
			!this.#closed &&
			this.ctx.session === this.#session &&
			this.ctx.settings === this.#settings &&
			this.ctx.sessionManager.getSessionId() === this.#sessionId &&
			getActiveProfile() === this.#profile
		);
	}
	#dirty(): boolean {
		return JSON.stringify(this.#draft) !== this.#baseline;
	}
	open(): void {
		this.#handle = this.ctx.ui.showOverlay(this, { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 });
		this.ctx.ui.setFocus(this);
		this.#unsubscribe = this.#settings.onEffectiveChange(
			[cfgTeamMembers],
			() => {
				if (!this.#current()) return;
				this.#message = this.#dirty()
					? "检测到外部配置变化；保留草稿。R 重读并比较后才可基于新版本保存。"
					: "检测到外部配置变化；正在重读。";
				void this.#read(false);
			},
			{ includeUserChanges: true },
		);
		void this.#read(true);
	}
	#close(): void {
		this.#closed = true;
		this.#unsubscribe?.();
		this.#handle?.hide();
		this.ctx.ui.requestRender();
	}
	invalidate(): void {}
	async #read(adoptRevision: boolean): Promise<void> {
		const generation = ++this.#readGeneration;
		const clientRevision = String(this.#clientRevision);
		try {
			const members =
				this.#draft?.map(member =>
					"rawSelector" in member ? member : { provider: member.provider, modelId: member.modelId },
				) ?? null;
			const snapshot = await this.#service.getConfig(this.#snapshot ? { clientRevision, members } : undefined);
			if (!this.#current() || generation !== this.#readGeneration || clientRevision !== String(this.#clientRevision))
				return;
			const first = !this.#snapshot;
			const refreshDraft =
				first ||
				(snapshot.userMembers !== undefined &&
					!this.#dirty() &&
					!this.#saving &&
					snapshot.revision !== this.#revision);
			this.#snapshot = snapshot;
			if (refreshDraft) {
				this.#draft =
					snapshot.userMembers?.map(slot =>
						slot.model
							? { ...slot.model, originalSelector: slot.rawSelector }
							: { rawSelector: slot.rawSelector },
					) ?? null;
				this.#baseline = JSON.stringify(this.#draft);
				this.#revision = snapshot.revision;
				this.#message = first ? "本地有序草稿；重复模型是独立代理槽位，保存后供后续讨论使用。" : "已重读外部配置。";
			} else if (adoptRevision) {
				this.#revision = snapshot.revision;
				this.#message = "已重读当前两端原值供比较；草稿保持不变。再次 S 将使用本次读取的版本。";
			} else if (snapshot.revision !== this.#revision) {
				this.#message = "外部版本已改变；草稿保留。R 重读比较后再保存。";
			}
			if (refreshDraft) void this.#preview();
		} catch (error) {
			if (this.#current() && generation === this.#readGeneration)
				this.#message = `读取失败：${printable(error instanceof Error ? error.message : error)}`;
		}
		if (this.#current()) this.ctx.ui.requestRender();
	}
	async #preview(): Promise<void> {
		const clientRevision = String(++this.#clientRevision);
		const generation = ++this.#readGeneration;
		try {
			const members =
				this.#draft?.map(member =>
					"rawSelector" in member ? member : { provider: member.provider, modelId: member.modelId },
				) ?? null;
			const snapshot = await this.#service.getConfig({ clientRevision, members });
			if (
				!this.#current() ||
				generation !== this.#readGeneration ||
				snapshot.preview?.clientRevision !== String(this.#clientRevision)
			)
				return;
			if (this.#revision !== snapshot.revision) this.#message = "外部版本已改变；草稿保留。R 重读比较后再保存。";
			this.#snapshot = snapshot;
		} catch (error) {
			if (this.#current() && generation === this.#readGeneration && clientRevision === String(this.#clientRevision))
				this.#message = `预览失败：${printable(error instanceof Error ? error.message : error)}`;
		}
		if (this.#current()) this.ctx.ui.requestRender();
	}
	#changed(): void {
		this.#selected = Math.max(0, Math.min(this.#selected, (this.#draft?.length ?? 0) - 1));
		this.#followSelection = true;
		void this.#preview();
		this.ctx.ui.requestRender();
	}
	#pick(replace: boolean): void {
		const selected = replace ? this.#draft?.[this.#selected] : undefined;
		const index = this.#selected;
		this.#handle?.setHidden(true);
		const resume = () => {
			if (!this.#current()) {
				this.#close();
				return;
			}
			this.#handle?.setHidden(false);
			this.ctx.ui.setFocus(this);
			void this.#read(false);
		};
		this.ctx.showModelSelector({
			selectOnly: {
				currentSelector:
					selected && !("rawSelector" in selected) ? `${selected.provider}/${selected.modelId}` : undefined,
				getCandidates: query => {
					const refs = new Set(
						this.#service
							.getModels(query)
							.models.filter(candidate => candidate.selectable)
							.map(candidate => `${candidate.model.provider}/${candidate.model.modelId}`),
					);
					return this.#session.modelRegistry.getAll().filter(model => refs.has(`${model.provider}/${model.id}`));
				},
				onSelect: selector => {
					if (!this.#current()) {
						this.#close();
						return;
					}
					const candidate = this.#service
						.getModels()
						.models.find(
							entry => entry.selectable && `${entry.model.provider}/${entry.model.modelId}` === selector,
						);
					if (candidate) {
						const draft = this.#draft ?? [];
						if (replace && draft[index]) draft[index] = candidate.model;
						else {
							draft.push(candidate.model);
							this.#selected = draft.length - 1;
						}
						this.#draft = draft;
						this.#message = "已加入独立槽位；仅修改草稿，尚未保存。";
						this.#changed();
					}
					resume();
				},
				onCancel: resume,
			},
		});
	}
	async #save(): Promise<void> {
		if (!this.#snapshot || this.#saving) return;
		if (!this.#revision || !this.#snapshot.writableScopes.includes("user")) {
			this.#message = "当前配置不可安全写入，请先修复读取问题并 R 重读。";
			return;
		}
		if (this.#draft?.some(member => "rawSelector" in member)) {
			this.#message = "旧槽位尚未解析：请替换或删除后保存。";
			return;
		}
		if (this.#snapshot.revision !== this.#revision) {
			this.#message = "版本冲突：草稿保留。请 R 重读并比较后再保存。";
			return;
		}
		const members: TeamModelRef[] | null =
			this.#draft === null
				? null
				: this.#draft.flatMap(member =>
						"rawSelector" in member ? [] : [{ provider: member.provider, modelId: member.modelId }],
					);
		this.#saving = true;
		++this.#clientRevision;
		++this.#readGeneration;
		this.#message = "正在保存；Esc 可退出。退出不代表撤销已提交写入，请重新打开核实结果。";
		this.ctx.ui.requestRender();
		try {
			const result = await this.#service.setConfig({ scope: "user", expectedRevision: this.#revision, members });
			if (!this.#current()) return;
			++this.#readGeneration;
			this.#snapshot = result.config;
			this.#message = `${result.saveState}：${result.effectiveMatchesRequested ? "保存且生效" : "已保存但有效值受高层覆盖"}；${printable(result.write)} ${result.effectiveNote ?? ""}`;
			if (result.saveState === "complete") {
				this.#baseline = JSON.stringify(this.#draft);
				this.#revision = result.config.revision;
			}
		} catch (error) {
			if (!this.#current()) return;
			++this.#readGeneration;
			if (error instanceof TeamConfigError && error.data?.config) this.#snapshot = error.data.config;
			if (error instanceof TeamConfigError) {
				const write = error.data ? `${error.data.saveState}；${printable(error.data.write)}` : "";
				const issues = error.data?.issues?.map(issue => issue.message).join("；");
				this.#message = `${error.code}：${error.message}；${write}${issues ? `；${issues}` : ""}。草稿保留；R 重读比较，禁止自动重试。`;
			} else {
				this.#message = `保存结果未知：${printable(error instanceof Error ? error.message : error)}。请重读核实，勿盲目重试。`;
			}
		} finally {
			this.#saving = false;
			if (this.#current()) this.ctx.ui.requestRender();
		}
	}

	handleInput(data: string): void {
		if (!this.#current()) {
			this.#close();
			return;
		}
		if (this.#confirmDiscard) {
			if (data === "y" || data === "Y") this.#close();
			else if (data === "n" || data === "N" || matchesKey(data, "escape")) this.#confirmDiscard = false;
			this.ctx.ui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			if (this.#dirty() || this.#saving) this.#confirmDiscard = true;
			else this.#close();
		} else if (matchesKey(data, "pageUp")) {
			this.#scroll = Math.max(0, this.#scroll - 8);
			this.#followSelection = false;
		} else if (matchesKey(data, "pageDown")) {
			this.#scroll += 8;
			this.#followSelection = false;
		} else if (data === "v" || data === "V") {
			this.#showAdvanced = !this.#showAdvanced;
			this.#followSelection = false;
		} else if (!this.#saving && this.#snapshot) {
			const draft = this.#draft ?? [];
			if (matchesKey(data, "up")) {
				this.#selected = Math.max(0, this.#selected - 1);
				this.#followSelection = true;
			} else if (matchesKey(data, "down")) {
				this.#selected = Math.min(Math.max(0, draft.length - 1), this.#selected + 1);
				this.#followSelection = true;
			} else if (data === "a") this.#pick(false);
			else if (data === "e" && draft.length) this.#pick(true);
			else if (data === "s") void this.#save();
			else if (data === "r") void this.#read(true);
			else if (data === "0") {
				this.#draft = [];
				this.#message = "恢复默认 []（尚未保存）。";
				this.#changed();
			} else if (draft.length && data === "c") {
				draft.splice(this.#selected + 1, 0, { ...draft[this.#selected]! });
				this.#draft = draft;
				this.#selected++;
				this.#changed();
			} else if (draft.length && (data === "d" || matchesKey(data, "delete"))) {
				draft.splice(this.#selected, 1);
				this.#draft = draft;
				this.#changed();
			} else if (draft.length && (data === "u" || data === "j")) {
				const target = this.#selected + (data === "u" ? -1 : 1);
				if (target >= 0 && target < draft.length) {
					[draft[target], draft[this.#selected]] = [draft[this.#selected]!, draft[target]!];
					this.#selected = target;
					this.#draft = draft;
					this.#changed();
				}
			}
		}
		this.ctx.ui.requestRender();
	}

	render(width: number): string[] {
		if (!this.#current()) {
			this.#close();
			return [];
		}
		const lines: string[] = [];
		const add = (line: string) => lines.push(...wrapLiteralLine(printable(line), Math.max(1, width)));
		const snapshot = this.#snapshot;
		add(`Team 配置 ${this.#dirty() ? "[未保存]" : ""}`);
		add(this.#message);
		if (snapshot) {
			if (snapshot.source === "project" || snapshot.source === "overlay" || snapshot.source === "runtime")
				add(`覆盖提示：${snapshot.source} 层高于用户层；保存用户名单不会移除此覆盖。`);
			for (const issue of snapshot.issues) add(`问题 [${issue.target}]: ${issue.message}`);
		}
		add("── 有序草稿（添加/复制同模型 = 另一个独立代理）──");
		let selectedRow = lines.length;
		if (this.#draft === null) add("未配置成员；0 恢复默认（需保存）");
		else if (!this.#draft.length) add("[] 默认回退，需保存才生效");
		for (const [index, member] of (this.#draft ?? []).entries()) {
			if (index === this.#selected) selectedRow = lines.length;
			const selector =
				"rawSelector" in member
					? member.rawSelector
					: (member.originalSelector ?? `${member.provider}/${member.modelId}`);
			add(
				`${index === this.#selected ? "▶" : " "} ${index + 1}. ${selector}${"rawSelector" in member ? " [旧槽位未解析：替换/删除]" : ""}`,
			);
			const slot =
				snapshot?.preview?.clientRevision === String(this.#clientRevision)
					? snapshot.preview.userMembers?.[index]
					: !this.#dirty()
						? snapshot?.userMembers?.[index]
						: undefined;
			if (slot)
				add(
					`   ${slot.name ?? ""} ${slot.model ? `${slot.model.provider}/${slot.model.modelId}` : ""} [${slot.status}] ${slot.reason ?? ""}`,
				);
			else add("   [尚未取得当前草稿预览；状态以共享服务结果为准]");
		}
		if (snapshot?.preview?.clientRevision === String(this.#clientRevision)) {
			const preview = snapshot.preview;
			for (const issue of preview.issues) add(`草稿问题: ${issue.message}`);
		}
		if (this.#showAdvanced && snapshot) {
			add("── 高级详情（只读）──");
			add(`profile: ${snapshot.profile ?? "default"} | source: ${snapshot.source} | ${snapshot.storage.readState}`);
			const showSlots = (name: string, slots: readonly TeamMemberSlot[] | null | undefined) => {
				add(
					`${name}: ${slots === undefined ? "不可读/不适用" : slots === null ? "缺失" : slots.length === 0 ? "[]" : ""}`,
				);
				for (const slot of slots ?? [])
					add(`  ${slot.index + 1}. ${slot.rawSelector} [${slot.status}] ${slot.reason ?? ""}`);
			};
			showSlots(`用户原值 [${snapshot.storage.readState}]`, snapshot.userMembers);
			showSlots("当前有效名单", snapshot.effectiveMembers);
			add(`实际运行槽位（只读预览）: ${printable(snapshot.participants)}`);
			if (snapshot.preview?.clientRevision === String(this.#clientRevision)) {
				const preview = snapshot.preview;
				add(`拟保存用户名单: ${printable(preview.userMembers)}`);
				add(`预计有效来源: ${preview.source}；有效名单: ${printable(preview.effectiveMembers)}`);
				add(`预计运行槽位: ${printable(preview.participants)}`);
			}
		}
		const footer = this.#confirmDiscard
			? "放弃草稿并退出？Y 放弃 / N 留在面板（保存中退出不撤销写入）"
			: `↑↓ 槽位 a 添加 e 替换 u 上移 j 下移 c 复制 d 删除 | 0 默认[] s 保存 r 重读比较 Esc 取消 | v 高级详情（${this.#showAdvanced ? "收起" : "展开"}） PgUp/PgDn 滚动`;
		const footerLines = wrapLiteralLine(footer, Math.max(1, width));
		const capacity = Math.max(1, (this.ctx.ui.terminal.rows || 24) - footerLines.length);
		if (this.#followSelection) {
			if (selectedRow < this.#scroll) this.#scroll = selectedRow;
			else if (selectedRow >= this.#scroll + capacity) this.#scroll = selectedRow - capacity + 1;
		}
		this.#followSelection = false;
		this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, lines.length - capacity)));
		return [...lines.slice(this.#scroll, this.#scroll + capacity), ...footerLines];
	}
}
