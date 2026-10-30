import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import type { Settings } from "./settings";

/** Weak ownership lets scoped lookup and test reset reach isolated instances without retaining them. */
const liveSettingsInstances = new Set<WeakRef<Settings>>();
const collectedSettingsInstances = new FinalizationRegistry<WeakRef<Settings>>(ref => {
	liveSettingsInstances.delete(ref);
});
const activeSettingsScope = new AsyncLocalStorage<Settings>();

export function registerSettingsInstance(instance: Settings): void {
	const ref = new WeakRef(instance);
	liveSettingsInstances.add(ref);
	collectedSettingsInstances.register(instance, ref, ref);
}

/** Visit live instances without retaining them beyond the current operation. */
export function forEachSettingsInstance(visit: (instance: Settings) => void): void {
	for (const ref of liveSettingsInstances) {
		const instance = ref.deref();
		if (instance) visit(instance);
		else {
			liveSettingsInstances.delete(ref);
			collectedSettingsInstances.unregister(ref);
		}
	}
}

/** The current async session's settings, without a process-global fallback. */
export function getActiveSettings(): Settings | undefined {
	return activeSettingsScope.getStore();
}

export function withActiveSettings<T>(instance: Settings | undefined, fn: () => T): T {
	return instance ? activeSettingsScope.run(instance, fn) : fn();
}

/** Active session identity wins; otherwise select the newest instance matching the explicit scope. */
export function findSettingsContext(cwd?: string, agentDir?: string): Settings | undefined {
	const active = getActiveSettings();
	if (active) return active;

	const wantCwd = cwd === undefined ? undefined : path.normalize(cwd);
	const wantAgentDir = agentDir === undefined ? undefined : path.normalize(agentDir);
	if (wantCwd === undefined && wantAgentDir === undefined) return undefined;

	let found: Settings | undefined;
	for (const ref of liveSettingsInstances) {
		const instance = ref.deref();
		if (
			instance &&
			(wantCwd === undefined || instance.getCwd() === wantCwd) &&
			(wantAgentDir === undefined || instance.getAgentDir() === wantAgentDir)
		) {
			found = instance;
		}
	}
	return found;
}

/** Disarm isolated instances too, so pending saves cannot leak into the next test. */
export function resetSettingsInstancesForTest(): void {
	for (const ref of liveSettingsInstances) {
		ref.deref()?.cancelPendingSaves();
		collectedSettingsInstances.unregister(ref);
	}
	liveSettingsInstances.clear();
}
