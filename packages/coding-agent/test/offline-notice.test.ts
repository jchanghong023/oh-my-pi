import { describe, expect, it } from "bun:test";
import { getOfflineSystemNotice } from "@oh-my-pi/pi-coding-agent/utils/offline-notice";

function noticeIds(notice: string | undefined): string[] {
	return [...(notice ?? "").matchAll(/<system-notice id="([^"]+)">/g)].map(match => match[1]!);
}

describe("offline prompt environment boundaries", () => {
	it("does not inject company restrictions into normal Linux/csh sessions", () => {
		expect(getOfflineSystemNotice(false, { platform: "linux", shell: "/bin/csh" })).toBeUndefined();
	});

	it("does not infer Linux or csh from a Windows process's inherited SHELL", () => {
		expect(noticeIds(getOfflineSystemNotice(true, { platform: "win32", shell: "/bin/csh" }))).toEqual(["offline"]);
	});

	it("adds Linux storage rules without imposing csh on Bash users", () => {
		expect(noticeIds(getOfflineSystemNotice(true, { platform: "linux", shell: "/bin/bash" }))).toEqual([
			"offline",
			"offline-linux",
		]);
	});

	it("recognizes both csh terminal names independently of their installation directory", () => {
		for (const shell of ["/bin/csh", "/usr/local/bin/tcsh"]) {
			expect(noticeIds(getOfflineSystemNotice(true, { platform: "linux", shell }))).toEqual([
				"offline",
				"offline-linux",
				"offline-csh",
			]);
		}
	});

	it("does not invent a csh terminal when SHELL is absent or merely contains csh", () => {
		for (const shell of [undefined, "/opt/csh/bin/sh"]) {
			expect(noticeIds(getOfflineSystemNotice(true, { platform: "linux", shell }))).toEqual([
				"offline",
				"offline-linux",
			]);
		}
	});
});
