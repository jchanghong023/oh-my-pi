import { type Component, type OverlayHandle, matchesKey, wrapLiteralLine } from "@oh-my-pi/pi-tui";
import { getActiveProfile, sanitizeText } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
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
			getSessionModel: () => this.#session.model,
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
		this.#unsubscribe = this.#settings.onEffectiveChange([cfgTeamMembers], () => {
			if (!this.#current()) return;
			this.#message = "检测到外部配置变化；保留草稿。R 重读并比较后才可基于新版本保存。";
			void this.#read(false);
		});
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
			this.#snapshot = snapshot;
			if (first) {
				this.#draft =
					snapshot.userMembers?.map(slot =>
						slot.model
							? { ...slot.model, originalSelector: slot.rawSelector }
							: { rawSelector: slot.rawSelector },
					) ?? null;
				this.#baseline = JSON.stringify(this.#draft);
				this.#message = "本地有序草稿；重复模型是独立代理槽位。主模型仅对齐与综合，不会改变。";
			}
			if (first || adoptRevision) this.#revision = snapshot.revision;
			if (adoptRevision && !first)
				this.#message = "已重读当前两端原值供比较；草稿保持不变。再次 S 将使用本次读取的版本。";
			if (first) void this.#preview();
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
			this.#message = `${result.saveState}：${result.effectiveMatchesRequested ? "保存且生效" : "已保存但有效值受高层覆盖"}；${printable(result.writes)} ${result.effectiveNote ?? ""}`;
			if (result.saveState === "complete") {
				this.#baseline = JSON.stringify(this.#draft);
				this.#revision = result.config.revision;
			}
		} catch (error) {
			if (!this.#current()) return;
			++this.#readGeneration;
			if (error instanceof TeamConfigError && error.data?.config) this.#snapshot = error.data.config;
			this.#message =
				error instanceof TeamConfigError
					? `${error.code}：${error.message}；${printable(error.data)}。草稿保留；R 重读比较，禁止自动重试。`
					: `保存结果未知：${printable(error instanceof Error ? error.message : error)}。请重读核实，勿盲目重试。`;
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
		add(`Team 配置 ${this.#dirty() ? "[未保存]" : ""} — 主模型不变`);
		add(this.#message);
		if (snapshot) {
			add(
				`profile: ${snapshot.profile ?? "default"} | source: ${snapshot.source} | ${snapshot.storage.mode}/${snapshot.storage.syncState}`,
			);
			if (snapshot.source === "project" || snapshot.source === "overlay" || snapshot.source === "runtime")
				add(`覆盖提示：${snapshot.source} 层高于用户层；保存用户名单不会移除此覆盖。`);
			const showSlots = (name: string, slots: readonly TeamMemberSlot[] | null | undefined) => {
				add(
					`${name}: ${slots === undefined ? "不可读/不适用" : slots === null ? "缺失" : slots.length === 0 ? "[]" : ""}`,
				);
				for (const slot of slots ?? [])
					add(`  ${slot.index + 1}. ${slot.rawSelector} [${slot.status}] ${slot.reason ?? ""}`);
			};
			showSlots(`活动原值 [${snapshot.storage.active.readState}]`, snapshot.userMembers);
			showSlots(`持久原值 [${snapshot.storage.persistent.readState}]`, snapshot.persistentMembers);
			showSlots("当前有效名单", snapshot.effectiveMembers);
			add(`主模型（对齐/综合）: ${printable(snapshot.sessionModel)}`);
			add(`实际运行槽位: ${printable(snapshot.participants)}`);
			for (const issue of snapshot.issues) add(`问题 [${issue.target}]: ${issue.message}`);
		}
		add("── 有序草稿（添加/复制同模型 = 另一个独立代理）──");
		let selectedRow = lines.length;
		if (this.#draft === null) add("未设置（保存 null 移除用户层；0 改为显式 []）");
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
			add(`拟保存用户名单: ${printable(preview.userMembers)}`);
			add(`预计有效来源: ${preview.source}；有效名单: ${printable(preview.effectiveMembers)}`);
			add(`预计运行槽位: ${printable(preview.participants)}`);
			for (const issue of preview.issues) add(`草稿问题: ${issue.message}`);
		}
		const footer = this.#confirmDiscard
			? "放弃草稿并退出？Y 放弃 / N 留在面板（保存中退出不撤销写入）"
			: "↑↓ 槽位 a 添加 e 替换 u 上移 j 下移 c 复制 d 删除 | 0 默认[] s 保存 r 重读比较 Esc 取消 | PgUp/PgDn 滚动";
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
