import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TempDir } from "@oh-my-pi/pi-utils";

export async function deadline<T>(promise: Promise<T>, milliseconds = 30_000): Promise<T> {
	const timeout = Promise.withResolvers<T>();
	const timer = setTimeout(
		() => timeout.reject(new Error(`Public process boundary exceeded ${milliseconds}ms`)),
		milliseconds,
	);
	try {
		return await Promise.race([promise, timeout.promise]);
	} finally {
		clearTimeout(timer);
	}
}

// Real CLI consumers use only disposable directories and cannot inherit credentials.
export async function goalCliFixture(root: TempDir, baseUrl?: string) {
	const cwd = root.join("project");
	const agentDir = root.join("config", "agent");
	const home = root.join("home");
	const temp = root.join("tmp");
	const appData = root.join("home", "AppData", "Roaming");
	const localData = root.join("home", "AppData", "Local");
	for (const directory of [cwd, agentDir, home, temp, appData, localData])
		await fs.mkdir(directory, { recursive: true });
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).map(([key, value]) => [
				key,
				/(?:key|token|secret|password|credential|authorization|(?:^|_)auth(?:_|$))/i.test(key) ? "" : value,
			]),
		),
		TZ: "UTC",
		OMP_CONFIG_ROOT: root.join("config"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: "default",
		PI_PROFILE: "",
		HOME: home,
		USERPROFILE: home,
		APPDATA: appData,
		LOCALAPPDATA: localData,
		XDG_CONFIG_HOME: root.join("config"),
		XDG_DATA_HOME: localData,
		XDG_CACHE_HOME: root.join("cache"),
		TMPDIR: temp,
		TEMP: temp,
		TMP: temp,
		OMP_OFFLINE: "0",
		PI_NO_TITLE: "1",
		PI_TEST_RUNTIME: "",
		NO_PROXY: "127.0.0.1,localhost",
		OPENSPEC_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: root.join("gitconfig"),
		GIT_CONFIG_COUNT: "0",
	};
	if (baseUrl)
		await Bun.write(
			path.join(agentDir, "models.yml"),
			`providers:\n  deepseek:\n    baseUrl: ${baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n`,
		);
	return {
		cwd,
		agentDir,
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	};
}
