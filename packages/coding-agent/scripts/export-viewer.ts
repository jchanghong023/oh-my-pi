import * as path from "node:path";
import type { ExportViewerMetadata } from "../../collab-web/scripts/build-export-viewer";
import { exportViewerDistName } from "../src/export/html/viewer-resource";

const packageDir = path.resolve(import.meta.dir, "..");
const htmlDir = path.join(packageDir, "src/export/html");

/** Reuse the exact viewer produced by the existing build preparation step. */
export async function readGeneratedExportViewer(): Promise<Uint8Array> {
	// Local generation can refresh the manifest after the build script was imported.
	const metadata: ExportViewerMetadata = await Bun.file(path.join(htmlDir, "viewer.generated.json")).json();
	const viewerPath = path.join(packageDir, "export-assets", metadata.file);
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(viewerPath).bytes();
	} catch (cause) {
		throw new Error(`Cannot read generated export viewer: ${viewerPath}. Run bun gen:export-viewer.`, { cause });
	}
	if (bytes.length !== metadata.size || `sha256-${Bun.SHA256.hash(bytes, "base64")}` !== metadata.integrity) {
		throw new Error(`Generated export viewer does not match its manifest: ${viewerPath}. Run bun gen:export-viewer.`);
	}
	return bytes;
}

/** Use Bun's file loader so the executable reads the viewer only when exporting. */
export async function embeddedExportViewerFiles(): Promise<Record<string, string | Uint8Array>> {
	return {
		[path.join(htmlDir, exportViewerDistName)]: await readGeneratedExportViewer(),
		[path.join(htmlDir, "viewer-resource.ts")]:
			`import viewerPath from "./${exportViewerDistName}" with { type: "file" };\n` +
			"export const embeddedExportViewerPath = viewerPath;\n" +
			`export const exportViewerDistName = ${JSON.stringify(exportViewerDistName)};\n`,
	};
}
