import { jsx, type KeyEvent, signal } from "@oh-my-pi/pi-tui";
import { wrapChars } from "@oh-my-pi/pi-tui/text/width";
import { getActiveProfile, sanitizeText } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import type { OverlayHandle } from "../ui/shell/overlays";
import "../ui/styles/apps/screen/look";
import { TeamConfigError, TeamConfigService } from "./config";
import type { TeamConfigSnapshot, TeamMemberSlot, TeamModelRef } from "./config-types";
import { cfgTeamMembers } from "./settings";

type DraftMember = (TeamModelRef & { originalSelector?: string }) | { rawSelector: string };

function printable(value: unknown): string {
	return sanitizeText(typeof value === "string" ? value : (JSON.stringify(value) ?? "Not read")).replaceAll(
		"\t",
		"    ",
	);
}

/** Configuration only: never dispatches a model call or mutates the session model. */
export function showTeamConfig(ctx: InteractiveModeContext): void {
	new TeamConfigPanel(ctx).open();
}

class TeamConfigPanel {
	readonly #session;
	readonly #settings;
	readonly #sessionId: string;
	readonly #service: TeamConfigService;
	readonly #profile = getActiveProfile();
	readonly #viewRevision = signal(0);
	#handle?: OverlayHandle;
	#unsubscribe?: () => void;
	#unsubscribeSessionChange?: () => void;
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
	#message = "Reading configuration (Esc closes without waiting for I/O)…";

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
		this.#handle = this.ctx.shell.overlays.show(
			() =>
				jsx("overlay", {
					size: "full",
					role: "omp.app.screen",
					page: {},
					children: jsx("col", {
						onKey: (key: KeyEvent) => this.#handleKey(key),
						children: () => {
							this.#viewRevision();
							const { columns, rows } = this.ctx.shell.size();
							return this.#rows(columns, rows).map(text => jsx("text", { text, wrap: "none" }));
						},
					}),
				}),
			{
				focus: root => root.children()[0] ?? root,
				onClose: () => {
					this.#closed = true;
					this.#unsubscribe?.();
					this.#unsubscribeSessionChange?.();
				},
			},
		);
		this.#unsubscribeSessionChange = this.#session.registerSessionChangeCallback(() => this.#close());
		this.#unsubscribe = this.#settings.onEffectiveChange(
			[cfgTeamMembers],
			() => {
				if (!this.#current()) return;
				this.#message = this.#dirty()
					? "Configuration changed elsewhere. Draft kept. Press R to reread and compare before saving."
					: "Configuration changed elsewhere. Rereading…";
				this.#refresh();
				void this.#read(false);
			},
			{ includeUserChanges: true },
		);
		void this.#read(true);
	}
	#close(): void {
		this.#handle?.close();
	}
	#refresh(): void {
		this.#viewRevision.set(this.#viewRevision.peek() + 1);
	}
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
					(adoptRevision || this.#snapshot?.revision === this.#revision) &&
					snapshot.revision !== this.#revision);
			this.#snapshot = snapshot;
			if (refreshDraft) {
				this.#draft =
					snapshot.userMembers?.map(slot =>
						slot.model
							? { ...slot.model, originalSelector: slot.rawSelector }
							: { rawSelector: slot.rawSelector },
					) ?? null;
				this.#selected = Math.max(0, Math.min(this.#selected, (this.#draft?.length ?? 0) - 1));
				this.#followSelection = true;
				this.#baseline = JSON.stringify(this.#draft);
				this.#revision = snapshot.revision;
				this.#message = first
					? "Changes are local until saved. Duplicate models run as independent agents in future discussions."
					: "External configuration reloaded.";
			} else if (adoptRevision) {
				this.#revision = snapshot.revision;
				this.#message =
					"Latest values loaded for comparison. Draft unchanged. Press S to save against this version.";
			} else if (snapshot.revision !== this.#revision) {
				this.#message = "Configuration version changed. Draft kept. Press R to reread and compare before saving.";
			}
			if (refreshDraft) void this.#preview();
		} catch (error) {
			if (this.#current() && generation === this.#readGeneration)
				this.#message = `Read failed: ${printable(error instanceof Error ? error.message : error)}`;
		}
		if (this.#current()) this.#refresh();
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
			if (this.#revision !== snapshot.revision)
				this.#message = "Configuration version changed. Draft kept. Press R to reread and compare before saving.";
			this.#snapshot = snapshot;
		} catch (error) {
			if (this.#current() && generation === this.#readGeneration && clientRevision === String(this.#clientRevision))
				this.#message = `Preview failed: ${printable(error instanceof Error ? error.message : error)}`;
		}
		if (this.#current()) this.#refresh();
	}
	#changed(): void {
		this.#selected = Math.max(0, Math.min(this.#selected, (this.#draft?.length ?? 0) - 1));
		this.#followSelection = true;
		void this.#preview();
		this.#refresh();
	}
	#pick(replace: boolean): void {
		const selected = replace ? this.#draft?.[this.#selected] : undefined;
		const index = this.#selected;
		const resume = () => {
			if (!this.#current()) {
				this.#close();
				return;
			}
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
						this.#message = "Independent slot added to the draft. Not saved yet.";
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
			this.#message = "Cannot write this configuration safely. Fix the read issue and press R to reread.";
			this.#refresh();
			return;
		}
		if (this.#draft?.some(member => "rawSelector" in member)) {
			this.#message = "Replace or remove unresolved slots before saving.";
			this.#refresh();
			return;
		}
		if (this.#snapshot.revision !== this.#revision) {
			this.#message = "Version conflict. Draft kept. Press R to reread and compare before saving.";
			this.#refresh();
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
		this.#message = "Saving… Esc closes the panel but does not undo the write. Reopen to verify the result.";
		this.#refresh();
		try {
			const result = await this.#service.setConfig({ scope: "user", expectedRevision: this.#revision, members });
			if (!this.#current()) return;
			++this.#readGeneration;
			this.#snapshot = result.config;
			this.#message = `${result.saveState}: ${result.effectiveMatchesRequested ? "Saved and effective" : "Saved but not effective"}; ${printable(result.write)} ${result.effectiveNote ?? ""}`;
			this.#baseline = JSON.stringify(this.#draft);
			this.#revision = result.config.revision;
		} catch (error) {
			if (!this.#current()) return;
			++this.#readGeneration;
			if (error instanceof TeamConfigError && error.data?.config) this.#snapshot = error.data.config;
			if (error instanceof TeamConfigError) {
				const write = error.data
					? `${error.data.write.status === "saved" ? "Write committed; " : ""}${printable(error.data.write)}`
					: "";
				const issues = error.data?.issues?.map(issue => issue.message).join("; ");
				this.#message = `${error.code}: ${error.message}${write ? `; ${write}` : ""}${issues ? `; ${issues}` : ""}. Draft kept. Press R to reread and compare; do not retry automatically.`;
			} else {
				this.#message = `Save result unknown: ${printable(error instanceof Error ? error.message : error)}. Reread to verify before retrying.`;
			}
		} finally {
			this.#saving = false;
			if (this.#current()) this.#refresh();
		}
	}

	#handleKey(key: KeyEvent): boolean {
		if (key.kind === "release") return false;
		const data = key.id;
		if (!this.#current()) {
			this.#close();
			return true;
		}
		if (this.#confirmDiscard) {
			if (data === "y" || data === "shift+y") this.#close();
			else if (data === "n" || data === "shift+n" || data === "escape") this.#confirmDiscard = false;
			this.#refresh();
			return true;
		}
		if (data === "escape" || data === "q") {
			if (this.#dirty() || this.#saving) this.#confirmDiscard = true;
			else this.#close();
		} else if (data === "pageUp") {
			this.#scroll = Math.max(0, this.#scroll - 8);
			this.#followSelection = false;
		} else if (data === "pageDown") {
			this.#scroll += 8;
			this.#followSelection = false;
		} else if (data === "v" || data === "shift+v") {
			this.#showAdvanced = !this.#showAdvanced;
			this.#followSelection = false;
		} else if (!this.#saving && this.#snapshot) {
			const draft = this.#draft ?? [];
			if (data === "up") {
				this.#selected = Math.max(0, this.#selected - 1);
				this.#followSelection = true;
			} else if (data === "down") {
				this.#selected = Math.min(Math.max(0, draft.length - 1), this.#selected + 1);
				this.#followSelection = true;
			} else if (data === "a") this.#pick(false);
			else if (data === "e" && draft.length) this.#pick(true);
			else if (data === "s") void this.#save();
			else if (data === "r") void this.#read(true);
			else if (data === "0") {
				this.#draft = [];
				this.#message = "Reset to default [] (not saved).";
				this.#changed();
			} else if (draft.length && data === "c") {
				draft.splice(this.#selected + 1, 0, { ...draft[this.#selected]! });
				this.#draft = draft;
				this.#selected++;
				this.#changed();
			} else if (draft.length && (data === "d" || data === "delete")) {
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
		this.#refresh();
		return true;
	}

	#rows(width: number, height: number): string[] {
		if (!this.#current()) return [];
		const lines: string[] = [];
		const add = (line: string) => lines.push(...wrapChars(printable(line), Math.max(1, width)));
		const snapshot = this.#snapshot;
		add(`Team configuration${this.#dirty() ? " [unsaved]" : ""}`);
		add(this.#message);
		if (snapshot) {
			if (snapshot.source === "project" || snapshot.source === "overlay" || snapshot.source === "runtime")
				add(`Override: ${snapshot.source} takes precedence over user settings. Saving won't remove this override.`);
			for (const issue of snapshot.issues) add(`Issue [${issue.target}]: ${issue.message}`);
		}
		add("── Ordered draft (adding or copying a model creates a separate agent slot) ──");
		let selectedRow = lines.length;
		if (this.#draft === null) add("No members configured. Press 0 to reset to default (save required).");
		else if (!this.#draft.length) add("[] Default fallback (save required)");
		for (const [index, member] of (this.#draft ?? []).entries()) {
			if (index === this.#selected) selectedRow = lines.length;
			const selector =
				"rawSelector" in member
					? member.rawSelector
					: (member.originalSelector ?? `${member.provider}/${member.modelId}`);
			add(
				`${index === this.#selected ? "▶" : " "} ${index + 1}. ${selector}${"rawSelector" in member ? " [unresolved slot: replace or delete]" : ""}`,
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
			else add("   [Preview pending; the configuration service determines slot status]");
		}
		if (snapshot?.preview?.clientRevision === String(this.#clientRevision)) {
			const preview = snapshot.preview;
			for (const issue of preview.issues) add(`Draft issue: ${issue.message}`);
		}
		if (this.#showAdvanced && snapshot) {
			add("── Advanced details (read-only) ──");
			add(`profile: ${snapshot.profile ?? "default"} | source: ${snapshot.source} | ${snapshot.storage.readState}`);
			const showSlots = (name: string, slots: readonly TeamMemberSlot[] | null | undefined) => {
				add(
					`${name}: ${slots === undefined ? "Unavailable or not applicable" : slots === null ? "Missing" : slots.length === 0 ? "[]" : ""}`,
				);
				for (const slot of slots ?? [])
					add(`  ${slot.index + 1}. ${slot.rawSelector} [${slot.status}] ${slot.reason ?? ""}`);
			};
			showSlots(`Stored user value [${snapshot.storage.readState}]`, snapshot.userMembers);
			showSlots("Current effective roster", snapshot.effectiveMembers);
			add(`Current run slots (read-only preview): ${printable(snapshot.participants)}`);
			if (snapshot.preview?.clientRevision === String(this.#clientRevision)) {
				const preview = snapshot.preview;
				add(`User roster to save: ${printable(preview.userMembers)}`);
				add(`Projected source: ${preview.source}; effective roster: ${printable(preview.effectiveMembers)}`);
				add(`Projected run slots: ${printable(preview.participants)}`);
			}
		}
		const footer = this.#confirmDiscard
			? "Discard draft and exit? Y discard / N stay (exiting during save does not undo the write)"
			: `↑↓ Select | a Add e Replace u Up j Down c Copy d Delete | 0 Default [] s Save r Reread Esc Cancel | v ${this.#showAdvanced ? "Hide" : "Show"} details PgUp/PgDn Scroll`;
		const footerLines = wrapChars(footer, Math.max(1, width));
		const capacity = Math.max(1, height - footerLines.length);
		if (this.#followSelection) {
			if (selectedRow < this.#scroll) this.#scroll = selectedRow;
			else if (selectedRow >= this.#scroll + capacity) this.#scroll = selectedRow - capacity + 1;
		}
		this.#followSelection = false;
		this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, lines.length - capacity)));
		return [...lines.slice(this.#scroll, this.#scroll + capacity), ...footerLines];
	}
}
