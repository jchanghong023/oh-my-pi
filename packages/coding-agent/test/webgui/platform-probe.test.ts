import { describe, expect, test } from "bun:test";
import {
	assertFirefox68Identity,
	assertPhysicalAndroid,
	PlatformPrerequisiteError,
	selectAndroidSerial,
	validateDirectUrl,
	type AndroidDeviceIdentity,
} from "../../../../scripts/webgui-platform-smoke";

// These test rejection/admission contracts only; none constitutes a real browser/device pass.
function expectPrerequisite(code: string, action: () => unknown): void {
	try {
		action();
	} catch (error) {
		expect(error).toBeInstanceOf(PlatformPrerequisiteError);
		expect((error as PlatformPrerequisiteError).prerequisite).toBe(code);
		return;
	}
	throw new Error(`Expected prerequisite ${code}`);
}

const phone: AndroidDeviceIdentity = {
	serial: "physical-serial",
	manufacturer: "Google",
	model: "Pixel 8",
	androidVersion: "15",
	qemu: "0",
	characteristics: "nosdcard",
};
const androidAgent =
	"Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/130.0.0.0 Mobile Safari/537.36";

describe("opt-in actual-platform prerequisite boundaries", () => {
	test("requires both Firefox capability and observed UA major 68", () => {
		expect(() => assertFirefox68Identity("68.12.0", "Mozilla/5.0 Firefox/68.0")).not.toThrow();
		expectPrerequisite("firefox68-version", () => assertFirefox68Identity("128.0", "Mozilla/5.0 Firefox/68.0"));
		expectPrerequisite("firefox68-version", () => assertFirefox68Identity("68.0", "Mozilla/5.0 Firefox/128.0"));
		expectPrerequisite("firefox68-version", () => assertFirefox68Identity("68.0", "Mozilla/5.0 Chrome/68.0"));
	});

	test("does not treat missing, unauthorized, or ambiguous ADB devices as a pass", () => {
		expectPrerequisite("android-device", () => selectAndroidSerial("List of devices attached\n"));
		expectPrerequisite("android-device", () =>
			selectAndroidSerial("List of devices attached\nphone unauthorized", "phone"),
		);
		expectPrerequisite("android-device", () =>
			selectAndroidSerial("List of devices attached\none device\ntwo device"),
		);
		expectPrerequisite("android-device", () =>
			selectAndroidSerial("List of devices attached\nphone offline", "phone"),
		);
		expect(selectAndroidSerial("List of devices attached\none device product:a model:Pixel\ntwo device", "one")).toBe(
			"one",
		);
	});

	test("rejects emulator identities even when the browser reports Android Mobile", () => {
		for (const identity of [
			{ ...phone, qemu: "1" },
			{ ...phone, serial: "emulator-5554" },
			{ ...phone, model: "sdk_gphone64_x86_64" },
		]) {
			expectPrerequisite("physical-android", () => assertPhysicalAndroid(identity, androidAgent));
		}
	});

	test("requires hardware identity plus phone browser identity, not a desktop viewport", () => {
		expect(() => assertPhysicalAndroid(phone, androidAgent)).not.toThrow();
		expectPrerequisite("android-phone-identity", () =>
			assertPhysicalAndroid({ ...phone, androidVersion: "" }, androidAgent),
		);
		expectPrerequisite("android-phone-identity", () =>
			assertPhysicalAndroid(phone, "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36"),
		);
		expectPrerequisite("android-phone-identity", () =>
			assertPhysicalAndroid(phone, "Mozilla/5.0 (Linux; Android 15) Chrome/130.0.0.0 Safari/537.36"),
		);
	});

	test("preserves direct OMP path/query and rejects relay protocols or credentials", () => {
		expect(validateDirectUrl("http://192.168.1.2:8765/webgui?project=real-session", true)).toBe(
			"http://192.168.1.2:8765/webgui?project=real-session",
		);
		for (const value of ["ws://192.168.1.2/rpc", "https://user:password@example.com/", "not a URL"]) {
			expectPrerequisite("omp-url", () => validateDirectUrl(value));
		}
	});

	test("does not mistake the phone loopback interface for the OMP host", () => {
		for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "[::1]", "0.0.0.0"]) {
			expectPrerequisite("android-lan-url", () => validateDirectUrl(`http://${host}:8765/`, true));
		}
		expect(validateDirectUrl("http://127.0.0.1:8765/", false)).toBe("http://127.0.0.1:8765/");
	});
});
