import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { encodeArchive, readArchiveEntries, writeArchive } from "../../src/ar";
import type { ArchiveMemberContent, WritableArchiveFormat } from "../../src/ar/types";

const formats: WritableArchiveFormat[] = ["zip", "tar", "tar.gz", "tar.zst", "asar"];

describe("archive writer upstream contract", () => {
	// The supported two-argument encoder must retain every writable format and
	// every content kind after removal of the fork-only cancellation interface.
	it.each(formats)("round-trips UTF-8, binary and Blob members through %s", async format => {
		const binary = new Uint8Array([0, 1, 127, 128, 255]);
		const members: Array<readonly [string, ArchiveMemberContent]> = [
			["nested\\说明.txt", "Unicode 文本\n"],
			["binary.dat", binary],
			["blob.txt", new Blob(["Blob contents\n"])],
		];
		const bytes = await encodeArchive(format, members);
		const decoded = await readArchiveEntries({ bytes, format });
		expect([...decoded.keys()].sort()).toEqual(["binary.dat", "blob.txt", "nested/说明.txt"]);
		expect(decoded.get("binary.dat")).toEqual(new Uint8Array([0, 1, 127, 128, 255]));
		expect(new TextDecoder().decode(decoded.get("nested/说明.txt"))).toBe("Unicode 文本\n");
		expect(new TextDecoder().decode(decoded.get("blob.txt"))).toBe("Blob contents\n");
		expect(members[0]?.[0]).toBe("nested\\说明.txt");
		expect(binary).toEqual(new Uint8Array([0, 1, 127, 128, 255]));
	});

	// Exercise the public filesystem consumer, including automatic parent creation.
	it.each(formats)("writes a readable %s archive into a new directory", async format => {
		using dir = TempDir.createSync("@archive-writer-contract-");
		const destination = dir.join("nested", `output.${format}`);
		await writeArchive(destination, format, [["report.txt", "saved report\n"]]);
		const members = await readArchiveEntries(destination);
		expect([...members.keys()]).toEqual(["report.txt"]);
		expect(new TextDecoder().decode(members.get("report.txt"))).toBe("saved report\n");
	});

	// A source failure is not cancellation or success, and must not overwrite an
	// existing destination with a partial archive.
	it("preserves the destination and original failure when a member cannot be materialized", async () => {
		using dir = TempDir.createSync("@archive-writer-failure-");
		const destination = dir.join("keep.zip");
		await Bun.write(destination, "existing archive bytes");
		const failure = new Error("member read failed");
		class UnreadableBlob extends Blob {
			override async arrayBuffer(): Promise<ArrayBuffer> {
				throw failure;
			}
		}
		await expect(writeArchive(destination, "zip", [["broken.txt", new UnreadableBlob()]])).rejects.toBe(failure);
		expect(await Bun.file(destination).text()).toBe("existing archive bytes");
	});
});
