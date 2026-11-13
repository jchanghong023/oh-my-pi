import { logger } from "@/logger.js";

export async function openFolderFromWorkspaceEntry({
  selectDirectory,
  onSelectProject,
}: {
  selectDirectory?: () => Promise<string | null>;
  onSelectProject: (path: string) => void;
}) {
  if (!selectDirectory) {
    return;
  }

  logger.info("[openWorkspaceFolderEntry] calling selectDirectory...");
  try {
    const dir = await selectDirectory();
    logger.info("[openWorkspaceFolderEntry] selectDirectory returned:", dir);
    if (dir) {
      onSelectProject(dir);
    } else {
      logger.info("[openWorkspaceFolderEntry] user cancelled or dir is null");
    }
  } catch (err) {
    logger.error("[openWorkspaceFolderEntry] selectDirectory threw:", err);
  }
}
