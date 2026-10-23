import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import {
	APP_NAME,
	getActiveProfile,
	getBaseConfigRoot,
	getOfflineShmState,
	getSessionsDirPath,
	normalizeProfileName,
	relativePathWithinNormalizedRoot,
	resolveEquivalentPath,
} from "@oh-my-pi/pi-utils/dirs";
import { z } from "zod";
import { LegacyProtocol as L } from "./schema";

const workspace = L.zcodeWorkflowsListParamsSchema.shape.workspace;
const profile = z.string().nullable();
const listParams = z.object({ workspace, candidate: profile.optional() }).strict();
const prepareParams = z.object({ workspace, expectedProfile: profile }).strict();
const cancelParams = z.object({ workspace, token: z.string().min(1) }).strict();
type Workspace = z.infer<typeof workspace>;
export interface OmpProfileBlocker {
	code: string;
	sessionId?: string;
	message: string;
}

export function getOmpProfileStorageIdentity() {
	const activeProfile = getActiveProfile() ?? null;
	const offline = getOfflineShmState();
	const configRoot = path.resolve(offline?.persistentRoot ?? getBaseConfigRoot());
	const resourcePath = path.resolve(path.dirname(getSessionsDirPath()));
	// scope 必须跟随实际数据域；相同 configRoot 下 agent override 可指向不同存储，
	// offline 则映射回持久路径，不能把临时 shm 的 host/uid 域写入客户端身份。
	const relative = offline ? relativePathWithinNormalizedRoot(offline.runtimeRoot, resourcePath) : null;
	const persistentPath = offline && relative !== null ? path.join(offline.persistentRoot, relative) : resourcePath;
	const canonicalPath = offline ? persistentPath : resolveEquivalentPath(persistentPath, { throughMissing: true });
	const storageScope = createHash("sha256")
		.update(process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath)
		.digest("hex");
	return { configRoot, activeProfile, storageScope };
}

/** Profile control observes native bootstrap identity; it never activates or copies a profile. */
export class OmpProfilesBridge {
	#barrier?: { token: string; workspace: string };
	constructor(readonly options: { cwd: string; blockers: () => OmpProfileBlocker[] }) {}
	get blocked(): boolean {
		return this.#barrier !== undefined;
	}
	#scope(value: Workspace): string {
		if (path.resolve(value.workspacePath) !== path.resolve(this.options.cwd))
			throw new Error("Profile workspace does not match this process execution directory");
		return JSON.stringify([path.resolve(value.workspacePath), value.workspaceIdentity?.trim() || value.workspaceKey]);
	}
	async list(raw: unknown) {
		const params = listParams.parse(raw);
		this.#scope(params.workspace);
		const candidate =
			params.candidate === undefined ? undefined : (normalizeProfileName(params.candidate ?? undefined) ?? null);
		const activeProfile = getActiveProfile() ?? null;
		const names = new Set<string>();
		if (activeProfile) names.add(activeProfile);
		const offline = getOfflineShmState();
		const { configRoot, storageScope } = getOmpProfileStorageIdentity();
		const roots = new Set([getBaseConfigRoot()]);
		if (offline) roots.add(offline.persistentRoot);
		// 与原生 resolver 一致：显式绝对 OMP root/offline 不采用 XDG。
		const explicitRoot = process.env.OMP_CONFIG_ROOT?.trim().replace(/^~(?=$|[\\/])/, homedir());
		if (
			!offline &&
			!(explicitRoot && path.isAbsolute(explicitRoot)) &&
			(process.platform === "linux" || process.platform === "darwin")
		) {
			for (const key of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) {
				const value = process.env[key];
				if (value) roots.add(path.join(value, APP_NAME));
			}
		}
		for (const root of roots) {
			let entries;
			try {
				entries = await fs.readdir(path.join(root, "profiles"), { withFileTypes: true });
			} catch (error) {
				if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
				throw error;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				try {
					const name = normalizeProfileName(entry.name);
					if (name && name === entry.name) names.add(name);
				} catch {
					/* 目录名不满足原生 profile 规范时不能作为可选身份。 */
				}
			}
		}
		return {
			activeProfile,
			configRoot,
			storageScope,
			profiles: [null, ...[...names].sort()].map(name => ({ name, active: name === activeProfile })),
			...(candidate === undefined ? {} : { candidate }),
		};
	}
	prepare(raw: unknown) {
		const params = prepareParams.parse(raw);
		const scope = this.#scope(params.workspace);
		if ((normalizeProfileName(params.expectedProfile ?? undefined) ?? null) !== (getActiveProfile() ?? null))
			throw new Error("Stale expectedProfile: native process profile changed");
		if (this.#barrier)
			return {
				ready: false,
				blockers: [{ code: "switchPrepared", message: "A profile switch is already prepared" }],
			};
		// 检查与准入屏障之间不能 await：否则 idle 检查后仍可进入新的业务 dispatch。
		const blockers = this.options.blockers();
		if (blockers.length) return { ready: false, blockers };
		const token = randomUUID();
		this.#barrier = { token, workspace: scope };
		return { ready: true, token, blockers: [] };
	}
	cancel(raw: unknown) {
		const params = cancelParams.parse(raw);
		const scope = this.#scope(params.workspace);
		if (this.#barrier?.token !== params.token || this.#barrier.workspace !== scope) return { cancelled: false };
		this.#barrier = undefined;
		return { cancelled: true };
	}
}
