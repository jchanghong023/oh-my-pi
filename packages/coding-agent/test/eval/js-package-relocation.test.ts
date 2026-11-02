import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("routes managed JavaScript and marketplace caches without moving their persistent directories", async () => {
	using temp = TempDir.createSync("@omp-js-relocation-");
	const config = temp.join("config");
	const cache = temp.join("performance");
	const selectedCache = process.platform === "linux" ? path.join(cache, String(process.getuid!())) : cache;
	const project = temp.join("project");
	await fs.mkdir(project);

	const installer = path.resolve(import.meta.dir, "../../src/eval/js/package-installer.ts");
	const registry = path.resolve(import.meta.dir, "../../src/extensibility/plugins/marketplace/registry.ts");
	const dirs = path.resolve(import.meta.dir, "../../../utils/src/dirs.ts");
	const script = `
import { resolveJsPackageEnvironment } from ${JSON.stringify(installer)};
import { getInstalledPluginsRegistryPath, getMarketplacesCacheDir, getPluginsCacheDir } from ${JSON.stringify(registry)};
import { getAgentDir, getPluginsDir } from ${JSON.stringify(dirs)};
const project = ${JSON.stringify(project)};
console.log(JSON.stringify({
  managed: resolveJsPackageEnvironment(project).root,
  project: resolveJsPackageEnvironment(project, "project").root,
  agent: getAgentDir(),
  plugins: getPluginsDir(),
  installed: getInstalledPluginsRegistryPath(),
  marketplacesCache: getMarketplacesCacheDir(),
  pluginsCache: getPluginsCacheDir(),
}));`;
	const run = async (cacheDir?: string, useXdg = false) => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			OMP_CONFIG_ROOT: config,
			OMP_OFFLINE: "0",
			OMP_PROFILE: "",
			PI_PROFILE: "",
		};
		delete env.PI_CODING_AGENT_DIR;
		if (cacheDir) env.OMP_CACHE_DIR = cacheDir;
		else delete env.OMP_CACHE_DIR;
		if (useXdg) {
			delete env.OMP_CONFIG_ROOT;
			env.HOME = temp.join("home");
			env.USERPROFILE = temp.join("home");
			env.XDG_CACHE_HOME = temp.join("xdg-cache");
		}
		const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0) throw new Error(`Relocation subprocess failed (${exitCode}): ${stderr}`);
		return JSON.parse(stdout) as {
			managed: string;
			project: string;
			agent: string;
			plugins: string;
			installed: string;
			marketplacesCache: string;
			pluginsCache: string;
		};
	};

	const original = await run();
	const relocated = await run(cache);
	expect(path.dirname(original.managed)).toBe(path.join(original.agent, "cache", "eval-js", "environments"));
	expect(path.dirname(relocated.managed)).toBe(path.join(selectedCache, "agent", "cache", "eval-js", "environments"));
	expect(relocated.project).toBe(await fs.realpath(project));
	expect(relocated.project).toBe(original.project);
	expect(relocated.installed).toBe(original.installed);
	expect(original.installed).toBe(path.join(original.plugins, "installed_plugins.json"));
	expect(original.marketplacesCache).toBe(path.join(original.plugins, "cache", "marketplaces"));
	expect(original.pluginsCache).toBe(path.join(original.plugins, "cache", "plugins"));
	expect(relocated.marketplacesCache).toBe(path.join(selectedCache, "plugins", "cache", "marketplaces"));
	expect(relocated.pluginsCache).toBe(path.join(selectedCache, "plugins", "cache", "plugins"));
	await fs.mkdir(temp.join("xdg-cache", "omp"), { recursive: true });
	const xdg = await run(undefined, true);
	expect(path.dirname(xdg.managed)).toBe(path.join(xdg.agent, "cache", "eval-js", "environments"));
});
