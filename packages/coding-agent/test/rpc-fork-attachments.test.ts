import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	MAX_ATTACHMENTS,
	RpcAttachmentError,
	resolveRpcAttachments,
	type RpcForkAttachment,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-attachments";

const MINIMAL_PDF = Buffer.from(
	`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 58 >>
stream
BT /F1 24 Tf 72 720 Td (Hello RPC PDF attachment) Tj ET
endstream
endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>
%%EOF`,
	"utf-8",
);

describe("resolveRpcAttachments (5.5)", () => {
	test("image data and file attachments become ImageContent entries", async () => {
		await using dir = await TempDir.create("rpc-attach-image-");
		const root = path.resolve(dir.path());
		const pngPath = path.join(root, "pixel.png");
		// 1x1 PNG
		await fs.writeFile(
			pngPath,
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const { images, textPrefix } = await resolveRpcAttachments(
			[
				{
					kind: "data",
					mime: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				},
				{ kind: "file", path: pngPath },
			],
			root,
		);
		expect(images).toHaveLength(2);
		expect(images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(images[1]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(textPrefix).toBe("");
	});

	test("pdf file attachments convert to a bounded markdown text block", async () => {
		await using dir = await TempDir.create("rpc-attach-pdf-");
		const root = path.resolve(dir.path());
		const pdfPath = path.join(root, "doc.pdf");
		await fs.writeFile(pdfPath, MINIMAL_PDF);
		const { images, textPrefix } = await resolveRpcAttachments([{ kind: "file", path: pdfPath }], root);
		expect(images).toHaveLength(0);
		expect(textPrefix).toContain('<attachment title="Attached PDF:');
		expect(textPrefix).toContain("Hello RPC PDF attachment");
	});

	test("text files ride in as bounded text blocks", async () => {
		await using dir = await TempDir.create("rpc-attach-text-");
		const filePath = path.join(dir.path(), "notes.md");
		await fs.writeFile(filePath, "# Notes\n\nhello attachment");
		const { textPrefix } = await resolveRpcAttachments([{ kind: "file", path: "notes.md" }], dir.path());
		expect(textPrefix).toContain("Attached file:");
		expect(textPrefix).toContain("# Notes");
	});

	test("error codes: limit, too_large, unreadable, unsupported", async () => {
		await using dir = await TempDir.create("rpc-attach-err-");
		const root = path.resolve(dir.path());
		const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({
			kind: "data" as const,
			mime: "text/plain",
			data: "aGk=",
		}));
		await expect(resolveRpcAttachments(many, root)).rejects.toMatchObject({ code: "attachment_limit" });

		const big = {
			kind: "data" as const,
			mime: "text/plain",
			data: Buffer.alloc(21 * 1024 * 1024, 97).toString("base64"),
		};
		await expect(resolveRpcAttachments([big], root)).rejects.toMatchObject({ code: "attachment_too_large" });

		await expect(
			resolveRpcAttachments([{ kind: "file", path: path.join(root, "missing.txt") }], root),
		).rejects.toMatchObject({ code: "attachment_unreadable" });

		await expect(
			resolveRpcAttachments([{ kind: "data", mime: "application/octet-stream", data: "aGk=" }], root),
		).rejects.toMatchObject({ code: "attachment_unsupported" });
		expect(await resolveRpcAttachments([{ kind: "data", mime: "text/plain", data: "aGk=" }], root)).toMatchObject({
			images: [],
		});
	});

	test("corrupt pdf rejects with attachment_unreadable instead of a bare error", async () => {
		await using dir = await TempDir.create("rpc-attach-pdf-bad-");
		const root = path.resolve(dir.path());
		const pdfPath = path.join(root, "broken.pdf");
		await fs.writeFile(pdfPath, "this text is definitely not a pdf");
		await expect(resolveRpcAttachments([{ kind: "file", path: pdfPath }], root)).rejects.toMatchObject({
			code: "attachment_unreadable",
		});
	});

	test("malformed wire shapes reject with attachment_unsupported", async () => {
		const root = path.resolve(import.meta.dir);
		const notArray = "nope" as unknown as RpcForkAttachment[];
		await expect(resolveRpcAttachments(notArray, root)).rejects.toMatchObject({
			code: "attachment_unsupported",
		});
		await expect(
			resolveRpcAttachments([{ kind: "file" } as unknown as RpcForkAttachment], root),
		).rejects.toMatchObject({ code: "attachment_unsupported" });
		await expect(
			resolveRpcAttachments([{ kind: "data", mime: "text/plain", data: 42 } as unknown as RpcForkAttachment], root),
		).rejects.toMatchObject({ code: "attachment_unsupported" });
	});

	test("RpcAttachmentError carries the wire code", () => {
		expect(new RpcAttachmentError("x", "attachment_limit").code).toBe("attachment_limit");
	});

	test("oversized file attachments reject via stat pre-check without reading the file", async () => {
		await using dir = await TempDir.create("rpc-attach-big-");
		const root = path.resolve(dir.path());
		const limit = 20 * 1024 * 1024;
		const bigPath = path.join(root, "big.log");
		await fs.writeFile(bigPath, Buffer.alloc(limit + 1, 120));
		const size = (await fs.stat(bigPath)).size;

		const realReadFile = fs.readFile;
		const readFileCalls: unknown[] = [];
		const wrappedReadFile = ((...args: unknown[]) => {
			readFileCalls.push(args[0]);
			return realReadFile(...(args as Parameters<typeof realReadFile>));
		}) as typeof fs.readFile;
		mock.module("node:fs/promises", () => ({ ...fs, readFile: wrappedReadFile }));
		try {
			let error: unknown;
			try {
				await resolveRpcAttachments([{ kind: "file", path: bigPath }], root);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(RpcAttachmentError);
			expect((error as RpcAttachmentError).code).toBe("attachment_too_large");
			expect((error as RpcAttachmentError).message).toBe(
				`Attachment exceeds the ${limit} byte limit: ${bigPath} (${size} bytes)`,
			);
			expect(readFileCalls).toHaveLength(0);
		} finally {
			// bun:test module mocks persist for the process (mock.restore() does not
			// undo mock.module), so hand the real readFile back before moving on.
			mock.module("node:fs/promises", () => ({ ...fs, readFile: realReadFile }));
		}

		// The under-limit path keeps reading files through the restored module.
		const smallPath = path.join(root, "small.txt");
		await fs.writeFile(smallPath, "still readable");
		const { textPrefix } = await resolveRpcAttachments([{ kind: "file", path: smallPath }], root);
		expect(textPrefix).toContain("still readable");
	});
});
