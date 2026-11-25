import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	unpackedExtensionId,
	writeRelayExtension,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { writeRelayNativeHost } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/native-host-manifest";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { relayNativePortFixture } from "./browser-relay-native-port-fixture";

export interface FixtureRelayExtension {
	dir: string;
	configureProfile?(profile: string): Promise<void>;
}

/** A real unpacked relay extension, paired only with its test relay. `root` belongs to the test. */
export async function prepareRelayExtension(root: string, port: number): Promise<FixtureRelayExtension> {
	const dir = path.join(root, "extension");
	await writeRelayExtension(dir, VERSION);
	if (process.platform === "win32") {
		// Chrome may resolve an unpacked path differently (and therefore assign a different ID).
		// Keep the real relay worker and browser, but isolate the native port without OS registry writes.
		const backgroundPath = path.join(dir, "background.js");
		const background = await Bun.file(backgroundPath).text();
		await Bun.write(backgroundPath, relayNativePortFixture(port) + background);
		return { dir };
	}
	const id = await unpackedExtensionId(dir);
	if (!id) throw new Error("Missing relay extension directory");
	const [manifest] = await writeRelayNativeHost([id], {
		home: root,
		configHome: root,
		dir: path.join(root, "native-host"),
		command: [
			process.execPath,
			path.resolve(import.meta.dir, "../fixtures/browser-relay-native-host.ts"),
			String(port),
		],
	});
	if (!manifest) throw new Error("No native host manifest for this platform");

	return {
		dir,
		async configureProfile(profile: string) {
			const hosts = path.join(profile, "NativeMessagingHosts");
			await fs.mkdir(hosts, { recursive: true });
			await fs.copyFile(manifest, path.join(hosts, path.basename(manifest)));
		},
	};
}
