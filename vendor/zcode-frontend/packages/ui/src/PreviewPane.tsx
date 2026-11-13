import { createPortal } from "react-dom";
import type { MarkdownSelectionTarget } from "@/lib/conversationSelectionReference.js";
/* eslint-disable max-lines -- PreviewPane 当前同时承载文件读取、图片与 PDF 预览、markdown/code 渲染和顶部路径面包屑；后续需按 header/body 边界继续拆分。 */
import {
  Fragment,
  type CSSProperties,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronRightIcon, Ellipsis, EyeIcon, FileCode2Icon } from "lucide-react";
import { nanoid } from "nanoid";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { FileMediaPreview, FileTextSlice } from "@zcode/shared";
import { TID_PREVIEW_PANE } from "@zcode/shared/test-ids";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePreviewFileWatch } from "@/hooks/usePreviewFileWatch.js";
import { useNativeHostAvailable } from "@/hooks/useBackendBusinessAvailability.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  FILE_VIEWER_MAX_TEXT_BYTES,
  createDiffSourceFilePreviewSource,
  inferImageMediaType,
  inferMediaPreview,
  type CodeViewerSource,
  type MediaCodeViewerSource,
} from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { getPathLeaf, isAbsoluteFilePath } from "@/lib/path.js";
import { OpenSplitButton } from "@/OpenSplitButton.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useCodeCommentPreviewStore } from "@/store/codeCommentPreviewStore.js";
import { resolveTheme } from "@/useTheme.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { PreviewPaneContent } from "@/previewPaneContent.js";
import {
  dispatchCodeCommentAddToChat,
  dispatchCodeCommentRemoveFromChat,
  isCodeCommentMarkedRemoved,
  type CodeCommentPreview,
  type CodeCommentRange,
} from "@/lib/codeCommentContext.js";
import {
  getWorkspaceFileRelativePath,
  isWorkspaceFilePathInside,
} from "@/workspace-file-tree/model.js";
import type { WorkspaceFileDragPayload } from "@/lib/workspaceFileDrag.js";

interface CodeViewerBreadcrumbData {
  rootLabel: string | null;
  parentSegments: string[];
  fileLabel: string;
  fileIconSrc: string | null;
}

type BreadcrumbMaskState = "none" | "left" | "right" | "both";

const BREADCRUMB_MASK_CLASS_BY_STATE: Record<BreadcrumbMaskState, string> = {
  none: "",
  left: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_100%)]",
  right:
    "[mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0,black_calc(100%-16px),transparent_100%)]",
  both: "[mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,transparent_0,black_16px,black_calc(100%-16px),transparent_100%)]",
};
const PREVIEW_PANE_DEFERRED_PLACEHOLDER_LINE_WIDTHS = [
  44, 72, 58, 86, 64, 78, 52, 90, 68, 48, 82, 60,
] as const;
const EMPTY_CODE_COMMENT_PREVIEWS: readonly CodeCommentPreview[] = [];

function normalizeBreadcrumbPathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function isMarkdownSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.language === "markdown";
}

function isSvgSource(source: CodeViewerSource): boolean {
  return source.type === "text" && source.path?.toLowerCase().endsWith(".svg") === true;
}

function isMarkdownFilePath(path?: string): boolean {
  if (!path) {
    return false;
  }

  const normalizedPath = path.toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

export function isPreviewPaneMissingFileError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bENOENT\b/i.test(message) || /no such file or directory/i.test(message);
}

export function isPreviewPaneFileTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /file is too large to preview/i.test(message);
}

export function getPreviewPaneSafeErrorMessage(error: unknown, sourcePath: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isAbsoluteFilePath(sourcePath)) {
    return message;
  }

  const sourceLeaf = getPathLeaf(sourcePath);
  const pathVariants = new Set([
    sourcePath,
    sourcePath.replace(/\\/g, "/"),
    sourcePath.replace(/\//g, "\\"),
  ]);

  let safeMessage = message;
  for (const pathVariant of pathVariants) {
    if (pathVariant !== sourceLeaf) {
      safeMessage = safeMessage.split(pathVariant).join(sourceLeaf);
    }
  }
  return safeMessage;
}

export function readPreviewPaneScrollMetrics(
  container: Pick<HTMLElement, "scrollHeight" | "scrollTop"> | null,
) {
  if (!container) {
    return null;
  }

  return {
    scrollHeight: container.scrollHeight,
    scrollTop: container.scrollTop,
  };
}

export function resolvePreviewPaneTextFileResult(result: FileTextSlice): {
  filePreview: FileTextSlice | null;
  fileTooLarge: boolean;
} {
  if (result.isBinary) {
    return {
      filePreview: result,
      fileTooLarge: false,
    };
  }

  return result.truncated
    ? {
        filePreview: null,
        fileTooLarge: true,
      }
    : {
        filePreview: result,
        fileTooLarge: false,
      };
}

function isSvgFilePath(path?: string): boolean {
  return path?.toLowerCase().endsWith(".svg") ?? false;
}

function decodeBase64ToArrayBuffer(dataBase64: string): ArrayBuffer {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function getFileImageMediaType(path?: string): string | null {
  const mediaType = inferImageMediaType(path);
  return mediaType && mediaType !== "image/svg+xml" ? mediaType : null;
}

// 与 service 层 readFileRange 的默认分段大小对齐，一次 range 请求对应一次 RPC 调用。
export function resolvePreviewPaneImageSource(
  source: CodeViewerSource | null,
): Extract<CodeViewerSource, { type: "image" }> | null {
  if (!source) {
    return null;
  }

  if (source.type === "image") {
    return source;
  }

  if (source.type !== "file") {
    return null;
  }

  const mediaType = getFileImageMediaType(source.path);
  if (!mediaType) {
    return null;
  }

  return {
    type: "image",
    title: source.title,
    path: source.path,
    mediaType,
  };
}

export function resolvePreviewPaneMediaSource(
  source: CodeViewerSource | null,
): MediaCodeViewerSource | null {
  if (!source) return null;
  if (source.type === "media") return source;
  if (source.type !== "file") return null;
  const media = inferMediaPreview(source.path);
  if (!media) return null;
  return { ...source, type: "media", ...media };
}

export function resolveMediaPlaybackErrorMessageId(
  code: number | undefined,
): "codeViewer.mediaUnsupported" | "codeViewer.mediaLoadFailed" {
  return code === 3 || code === 4 ? "codeViewer.mediaUnsupported" : "codeViewer.mediaLoadFailed";
}

export function shouldShowPreviewPaneHeaderDivider(source: CodeViewerSource | null): boolean {
  return Boolean(resolvePreviewPaneMediaSource(source));
}

function isPlainCodeSource(source: CodeViewerSource | null): boolean {
  if (!source) {
    return false;
  }

  if (source.type === "text") {
    return !isMarkdownSource(source) && !isSvgSource(source);
  }

  if (source.type === "file") {
    return (
      !isMarkdownFilePath(source.path) &&
      !isSvgFilePath(source.path) &&
      !getFileImageMediaType(source.path)
    );
  }

  if (source.type === "media") return false;

  if (source.type === "code-review") {
    return true;
  }

  return false;
}

export function getPreviewPaneDisplayOptions(
  source: CodeViewerSource | null,
  viewModes: {
    markdownViewMode?: "preview" | "code";
    svgViewMode?: "preview" | "code";
  } = {},
) {
  const canToggleMarkdownView =
    source !== null &&
    (isMarkdownSource(source) || (source.type === "file" && isMarkdownFilePath(source.path)));
  const canToggleSvgView =
    source !== null &&
    (isSvgSource(source) || (source.type === "file" && isSvgFilePath(source.path)));
  const canToggleCodeWrap =
    isPlainCodeSource(source) ||
    (canToggleMarkdownView && viewModes.markdownViewMode === "code") ||
    (canToggleSvgView && viewModes.svgViewMode === "code");

  return {
    canToggleCodeWrap,
    canToggleMarkdownView,
    canToggleSvgView,
    hasMoreMenu: canToggleMarkdownView || canToggleSvgView || canToggleCodeWrap,
  };
}

function buildCodeViewerBreadcrumb(
  source: CodeViewerSource,
  workspacePath?: string,
): CodeViewerBreadcrumbData | null {
  const sourcePath = source.path;
  if (!sourcePath) {
    if (!source.title.trim()) {
      return null;
    }

    return {
      rootLabel: null,
      parentSegments: [],
      fileLabel: source.title,
      fileIconSrc: null,
    };
  }

  const normalizedSourcePath = sourcePath.replace(/\\/g, "/");
  const normalizedWorkspacePath = workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
  const sourceLeaf = getPathLeaf(sourcePath);
  const descriptor = resolveFileDisplayDescriptor(sourcePath);
  if (
    normalizedWorkspacePath &&
    (normalizedSourcePath === normalizedWorkspacePath ||
      normalizedSourcePath.startsWith(`${normalizedWorkspacePath}/`))
  ) {
    const relativePath =
      normalizedSourcePath === normalizedWorkspacePath
        ? ""
        : normalizedSourcePath.slice(normalizedWorkspacePath.length + 1);
    const relativeSegments = normalizeBreadcrumbPathSegments(relativePath);

    return {
      rootLabel: getPathLeaf(normalizedWorkspacePath),
      parentSegments: relativeSegments.slice(0, -1),
      fileLabel: relativeSegments.at(-1) ?? sourceLeaf,
      fileIconSrc: descriptor.fileIconSrc,
    };
  }

  const sourceSegments = normalizeBreadcrumbPathSegments(normalizedSourcePath);
  return {
    rootLabel: sourcePath.startsWith("/") ? "/" : (sourceSegments[0] ?? null),
    parentSegments: sourcePath.startsWith("/")
      ? sourceSegments.slice(0, -1)
      : sourceSegments.slice(1, -1),
    fileLabel: sourceSegments.at(-1) ?? sourceLeaf,
    fileIconSrc: descriptor.fileIconSrc,
  };
}

export function resolvePreviewPaneImageFileReference(
  source: CodeViewerSource | null,
  workspacePath?: string,
  targetWorkspaceKey?: string,
): WorkspaceFileDragPayload | undefined {
  const sourceWorkspacePath = source?.workspacePath ?? workspacePath;
  const workspaceIdentity = source?.workspaceIdentity?.trim();
  if (!source?.path || !sourceWorkspacePath) return undefined;
  const sourceWorkspaceKey = workspaceIdentity || sourceWorkspacePath;
  const sourceIsRemote = Boolean(workspaceIdentity || source.workspaceRemoteSessionId);
  const targetIsRemote = Boolean(
    workspacePath && targetWorkspaceKey && targetWorkspaceKey !== workspacePath,
  );
  // 本地文件沿用文件树的跨工作区绝对引用；远端必须匹配身份，不能把另一 Host 的 path 交给当前草稿。
  if ((sourceIsRemote || targetIsRemote) && sourceWorkspaceKey !== targetWorkspaceKey)
    return undefined;
  return {
    type: "file",
    workspacePath: sourceWorkspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    path: source.path,
    // 预览允许工作区外路径；文件树的相对路径 helper 对外部文件只返回文件名，会误指向同名文件。
    relativePath: isWorkspaceFilePathInside(sourceWorkspacePath, source.path)
      ? getWorkspaceFileRelativePath(sourceWorkspacePath, source.path)
      : source.path,
    name: getPathLeaf(source.path) || source.title,
  };
}

export function PreviewPane({
  source: rawSource,
  workspacePath,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  renderHeavyContent = true,
  headerContainer,
  markdownSelectionTarget,
}: {
  source: CodeViewerSource | null;
  onClose: () => void;
  workspacePath?: string;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  renderHeavyContent?: boolean;
  /** 文件管理器将面包屑与目录开关放在同一工具栏，仍由预览维护文件操作。 */
  headerContainer?: HTMLElement | null;
  markdownSelectionTarget?: MarkdownSelectionTarget;
}) {
  const { intl } = useZCodeIntl();
  const nativeHostAvailable = useNativeHostAvailable();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const source = useMemo(
    () => (rawSource ? normalizeCodeViewerSource(rawSource) : null),
    [rawSource],
  );
  const sourceWorkspacePath = source?.workspacePath ?? workspacePath;
  const imageFileReference = useMemo(
    () =>
      resolvePreviewPaneImageFileReference(
        source,
        workspacePath,
        markdownSelectionTarget?.workspaceKey,
      ),
    [source, workspacePath, markdownSelectionTarget?.workspaceKey],
  );
  const { fileService, fileWatcherService, mediaPreviewService } = useWorkspaceServices(
    sourceWorkspacePath,
    source?.workspaceRemoteSessionId,
    source?.workspaceIdentity,
  );
  const sourceFilePath = source?.path;
  const watchedFilePath =
    source &&
    source.type !== "text" &&
    source.type !== "patch" &&
    source.type !== "multi-file-diff" &&
    nativeHostAvailable
      ? source.path
      : null;
  const { ready: previewFileWatchReady, reloadGeneration: previewReloadGeneration } = usePreviewFileWatch({
    filePath: watchedFilePath,
    fileWatcherService,
  });
  const loadImageDownloadSource = useCallback(async () => {
    if (!sourceFilePath) throw new Error("Image source path is unavailable");
    // SVG 文本预览按 UTF-8 解码；下载必须从同一来源 Host 读取原字节，保留其他编码及 XML 声明。
    const original = await fileService.readMediaPreview({ path: sourceFilePath });
    return `data:${original.mediaType};base64,${original.dataBase64}`;
  }, [fileService, sourceFilePath]);
  const [filePreview, setFilePreview] = useState<FileTextSlice | null>(null);
  const [fileTooLarge, setFileTooLarge] = useState(false);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingImagePreview, setLoadingImagePreview] = useState(false);
  const [imagePreview, setImagePreview] = useState<FileMediaPreview | null>(null);
  const [loadingMediaPreview, setLoadingMediaPreview] = useState(false);
  const [mediaPreviewUrl, setMediaPreviewUrl] = useState<string | null>(null);
  const [mediaPreviewId, setMediaPreviewId] = useState<string | null>(null);
  const mediaPreviewGenerationRef = useRef(0);
  const mediaRefreshAttemptedRef = useRef(false);
  const mediaRefreshInFlightRef = useRef(false);
  const mediaRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaPlaybackRestoreRef = useRef<{
    currentTime: number;
    paused: boolean;
    volume: number;
    muted: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [markdownViewMode, setMarkdownViewMode] = useState<"preview" | "code">("preview");
  const [svgViewMode, setSvgViewMode] = useState<"preview" | "code">("preview");
  const [wrapLongLinesOverride, setWrapLongLinesOverride] = useState<boolean | null>(null);
  const [breadcrumbMaskState, setBreadcrumbMaskState] = useState<BreadcrumbMaskState>("none");
  const breadcrumbScrollRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbContentRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const preservedScrollMetricsRef = useRef({
    scrollHeight: 0,
    scrollTop: 0,
  });
  const previousRenderHeavyContentRef = useRef(renderHeavyContent);
  const resolvedTheme = resolveTheme(theme);
  const codeTheme =
    resolvedTheme === "dark" ? codePreviewSettings.darkTheme : codePreviewSettings.lightTheme;
  const imageSource = useMemo(() => resolvePreviewPaneImageSource(source), [source]);
  const mediaSource = useMemo(() => resolvePreviewPaneMediaSource(source), [source]);
  const showDocumentHeaderDivider = shouldShowPreviewPaneHeaderDivider(source);
  const diffFilePreviewSource = useMemo(
    () =>
      source?.type === "patch" || source?.type === "multi-file-diff"
        ? createDiffSourceFilePreviewSource(source, sourceWorkspacePath)
        : null,
    [source, sourceWorkspacePath],
  );
  const fileSource =
    (source?.type === "file" || source?.type === "code-review") &&
    !imageSource &&
    !mediaSource
      ? source
      : null;
  const codeCommentBucket = useMemo(
    () =>
      source?.type !== "code-review" && source?.path && sourceWorkspacePath
        ? {
            workspacePath: sourceWorkspacePath,
            workspaceIdentity: source.workspaceIdentity,
            sourcePath: source.path,
          }
        : null,
    [source, sourceWorkspacePath],
  );
  const codeComments = useCodeCommentPreviewStore((state) =>
    // code-review 不读取 Composer 评论 store，但这里每次 selector 求值都不能返回新的 []，
    // 否则会破坏 useSyncExternalStore 的稳定 snapshot 契约并触发无限更新。
    codeCommentBucket ? state.getComments(codeCommentBucket) : EMPTY_CODE_COMMENT_PREVIEWS,
  );
  const addCodeCommentPreview = useCodeCommentPreviewStore((state) => state.addComment);
  const removeCodeCommentPreview = useCodeCommentPreviewStore((state) => state.removeComment);
  const breadcrumb = useMemo(
    () => (source ? buildCodeViewerBreadcrumb(source, sourceWorkspacePath) : null),
    [source, sourceWorkspacePath],
  );
  const canOpenDiffFilePreview = Boolean(diffFilePreviewSource && onOpenCodeViewer);
  const wrapLongLines = wrapLongLinesOverride ?? codePreviewSettings.wrapLongLines;
  const canCreateCodeComment = Boolean(
    source?.type !== "code-review" && source?.path && sourceWorkspacePath,
  );
  const displayOptions = useMemo(
    () =>
      getPreviewPaneDisplayOptions(source, {
        markdownViewMode,
        svgViewMode,
      }),
    [markdownViewMode, source, svgViewMode],
  );
  const { canToggleCodeWrap, canToggleMarkdownView, canToggleSvgView, hasMoreMenu } =
    displayOptions;
  const codeCommentLabels = useMemo(
    () => ({
      addComment: intl.formatMessage({ id: "codeViewer.comment.add" }),
      addCommentTooltip: intl.formatMessage({
        id: "codeViewer.comment.addTooltip",
      }),
      commentPlaceholder: intl.formatMessage({
        id: "codeViewer.comment.placeholder",
      }),
      submitComment: intl.formatMessage({ id: "codeViewer.comment.submit" }),
      cancelComment: intl.formatMessage({ id: "common.cancel" }),
      deleteComment: intl.formatMessage({ id: "codeViewer.comment.delete" }),
      commentLine: intl.formatMessage({ id: "codeViewer.comment.line" }),
      commentRange: intl.formatMessage({ id: "codeViewer.comment.range" }),
    }),
    [intl],
  );

  useEffect(() => {
    if (!source) {
      return;
    }

    setMarkdownViewMode(
      source.type !== "code-review" && (isMarkdownSource(source) || isMarkdownFilePath(source.path))
        ? "preview"
        : "code",
    );
    setSvgViewMode(
      source.type !== "code-review" && (isSvgSource(source) || isSvgFilePath(source.path))
        ? "preview"
        : "code",
    );
    setWrapLongLinesOverride(null);
  }, [source]);

  const handleSubmitCodeComment = useCallback(
    (params: { range: CodeCommentRange; selectedText: string; comment: string }) => {
      if (!source?.path || !sourceWorkspacePath) {
        return;
      }

      const normalizedComment = params.comment.trim();
      const commentId = nanoid();
      dispatchCodeCommentAddToChat({
        id: commentId,
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        sourceTitle: source.title,
        startLine: params.range.startLine,
        endLine: params.range.endLine,
        selectedText: params.selectedText,
        comment: normalizedComment,
        contextLabel: intl.formatMessage({
          id: "codeViewer.comment.contextLabel",
        }),
        commentLabel: intl.formatMessage({
          id: "codeViewer.comment.commentLabel",
        }),
      });
      if (
        isCodeCommentMarkedRemoved({
          id: commentId,
          workspacePath: sourceWorkspacePath,
          workspaceIdentity: source.workspaceIdentity,
        })
      ) {
        return;
      }
      addCodeCommentPreview({
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        comment: {
          id: commentId,
          sourcePath: source.path,
          sourceTitle: source.title,
          startLine: params.range.startLine,
          endLine: params.range.endLine,
          selectedText: params.selectedText,
          comment: normalizedComment,
        },
      });
    },
    [addCodeCommentPreview, intl, source, sourceWorkspacePath],
  );

  const handleDeleteCodeComment = useCallback(
    (commentId: string) => {
      if (!source?.path || !sourceWorkspacePath) {
        return;
      }
      removeCodeCommentPreview({
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
        sourcePath: source.path,
        id: commentId,
      });
      dispatchCodeCommentRemoveFromChat({
        id: commentId,
        workspacePath: sourceWorkspacePath,
        workspaceIdentity: source.workspaceIdentity,
      });
    },
    [removeCodeCommentPreview, source, sourceWorkspacePath],
  );

  const rememberScrollMetrics = useCallback(() => {
    const metrics = readPreviewPaneScrollMetrics(scrollContainerRef.current);
    if (!metrics) {
      return;
    }

    preservedScrollMetricsRef.current = metrics;
  }, []);

  useLayoutEffect(() => {
    const viewport = breadcrumbScrollRef.current;
    if (!viewport) {
      return;
    }

    // 交互说明：长路径首次打开时，用户最关心的是末尾文件名。
    // 这里在 breadcrumb 内容变更后只初始化滚到最右侧，后续用户手动滚动不再强行回弹。
    const frameId = requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [breadcrumb, headerContainer]);

  useLayoutEffect(() => {
    const viewport = breadcrumbScrollRef.current;
    const content = breadcrumbContentRef.current;
    if (!viewport || !content) {
      setBreadcrumbMaskState("none");
      return;
    }

    const updateMaskState = () => {
      const maxScrollLeft = viewport.scrollWidth - viewport.clientWidth;
      if (maxScrollLeft <= 1) {
        setBreadcrumbMaskState("none");
        return;
      }

      const hasHiddenLeft = viewport.scrollLeft > 1;
      const hasHiddenRight = viewport.scrollLeft < maxScrollLeft - 1;
      setBreadcrumbMaskState(
        hasHiddenLeft && hasHiddenRight
          ? "both"
          : hasHiddenLeft
            ? "left"
            : hasHiddenRight
              ? "right"
              : "none",
      );
    };

    // RAF-based debounce to coalesce resize events
    let rafId: number | null = null;
    let latestCallback = updateMaskState;
    const debouncedUpdate = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        latestCallback();
      });
    };

    updateMaskState();
    viewport.addEventListener("scroll", updateMaskState, { passive: true });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", debouncedUpdate);
      return () => {
        viewport.removeEventListener("scroll", updateMaskState);
        window.removeEventListener("resize", debouncedUpdate);
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }

    const resizeObserver = new ResizeObserver(() => {
      latestCallback = updateMaskState;
      debouncedUpdate();
    });
    resizeObserver.observe(viewport);
    resizeObserver.observe(content);
    window.addEventListener("resize", debouncedUpdate);

    return () => {
      viewport.removeEventListener("scroll", updateMaskState);
      resizeObserver.disconnect();
      window.removeEventListener("resize", debouncedUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [breadcrumb, headerContainer]);

  useEffect(() => {
    let disposed = false;

    preservedScrollMetricsRef.current = {
      scrollHeight: 0,
      scrollTop: 0,
    };
    setFilePreview(null);
    setFileTooLarge(false);
    setError(null);
    setLoadingInitial(Boolean(fileSource));
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = 0;
    }

    if (!fileSource) {
      return () => {
        disposed = true;
      };
    }

    // 把传输分块直接当成多个文档解码和渲染，会在 UTF-8 字符中间产生乱码，
    // 同时让每块行号从 1 重置。文本预览现在只读取 service 允许的完整上限；
    // 非二进制结果返回 truncated 时丢弃局部文本并提示文件过大，不再拼接分块。
    void fileService
      .readTextFile({
        path: fileSource.path,
        offset: 0,
        length: FILE_VIEWER_MAX_TEXT_BYTES,
      })
      .then((result) => {
        if (disposed) {
          return;
        }

        const nextFileState = resolvePreviewPaneTextFileResult(result);
        setFilePreview(nextFileState.filePreview);
        setFileTooLarge(nextFileState.fileTooLarge);
      })
      .catch((readError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取文件失败 path=${fileSource.path}:`, readError);
        setError(
          isPreviewPaneMissingFileError(readError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : readError instanceof Error
              ? readError.message
              : String(readError),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingInitial(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, fileSource, intl, previewReloadGeneration]);

  useEffect(() => {
    let disposed = false;

    if (!imageSource) {
      setImagePreview(null);
      setLoadingImagePreview(false);
      return () => {
        disposed = true;
      };
    }

    setLoadingImagePreview(true);
    setImagePreview(null);
    setError(null);

    void fileService
      .readMediaPreview({ path: imageSource.path })
      .then((result) => {
        if (disposed) {
          return;
        }

        setImagePreview(result);
      })
      .catch((previewError: unknown) => {
        if (disposed) {
          return;
        }

        logger.error(`[PreviewPane] 读取图片预览失败 path=${imageSource.path}:`, previewError);
        setError(
          isPreviewPaneMissingFileError(previewError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : previewError instanceof Error
              ? previewError.message
              : String(previewError),
        );
      })
      .finally(() => {
        if (!disposed) {
          setLoadingImagePreview(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [fileService, imageSource, intl, previewReloadGeneration]);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    let preparedPreviewId: string | null = null;
    const generation = ++mediaPreviewGenerationRef.current;

    if (!mediaSource) {
      setLoadingMediaPreview(false);
      setMediaPreviewUrl(null);
      setMediaPreviewId(null);
      mediaRefreshAttemptedRef.current = false;
      if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
      mediaRefreshTimerRef.current = null;
      mediaPlaybackRestoreRef.current = null;
      return () => {
        disposed = true;
      };
    }

    setLoadingMediaPreview(true);
    setMediaPreviewUrl(null);
    setMediaPreviewId(null);
    setError(null);
    mediaRefreshAttemptedRef.current = false;
    mediaRefreshInFlightRef.current = false;
    if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
    mediaRefreshTimerRef.current = null;
    mediaPlaybackRestoreRef.current = null;
    if (!mediaPreviewService) {
      setLoadingMediaPreview(false);
      setError(intl.formatMessage({ id: "codeViewer.mediaUnavailable" }));
      return () => {
        disposed = true;
      };
    }

    void mediaPreviewService
      .prepare({
        path: mediaSource.path,
        expectedKind: mediaSource.kind,
      })
      .then((preview) => {
        const previewId = "previewId" in preview ? preview.previewId : null;
        if (previewId) preparedPreviewId = previewId;
        if (disposed || generation !== mediaPreviewGenerationRef.current) {
          if (previewId && mediaPreviewService?.release) {
            void mediaPreviewService.release({ previewId }).catch(() => undefined);
          }
          return;
        }
        if ("url" in preview) {
          if (previewId) setMediaPreviewId(previewId);
          setMediaPreviewUrl(preview.url);
        } else {
          objectUrl = URL.createObjectURL(
            new Blob([decodeBase64ToArrayBuffer(preview.dataBase64)], {
              type: preview.mediaType,
            }),
          );
          setMediaPreviewUrl(objectUrl);
        }
      })
      .catch((previewError: unknown) => {
        if (disposed || generation !== mediaPreviewGenerationRef.current) return;
        logger.error("[PreviewPane] 读取媒体预览失败", {
          path: mediaSource.path,
          error: previewError instanceof Error ? previewError.message : String(previewError),
        });
        setError(
          isPreviewPaneMissingFileError(previewError)
            ? intl.formatMessage({ id: "codeViewer.fileMissing" })
            : previewError instanceof Error
              ? previewError.message
              : String(previewError),
        );
      })
      .finally(() => {
        if (!disposed && generation === mediaPreviewGenerationRef.current) {
          setLoadingMediaPreview(false);
        }
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (mediaRefreshTimerRef.current) clearTimeout(mediaRefreshTimerRef.current);
      mediaRefreshTimerRef.current = null;
      if (preparedPreviewId && mediaPreviewService?.release) {
        void mediaPreviewService.release({ previewId: preparedPreviewId }).catch(() => undefined);
      }
    };
  }, [intl, mediaPreviewService, mediaSource, previewReloadGeneration]);

  const handleMediaError = useCallback(
    (event: SyntheticEvent<HTMLMediaElement>) => {
      const mediaElement = event.currentTarget;
      const refreshPlaybackUrl = mediaPreviewService?.refreshPlaybackUrl;
      if (!mediaPreviewId || !refreshPlaybackUrl) {
        setError(
          intl.formatMessage({
            id: resolveMediaPlaybackErrorMessageId(mediaElement.error?.code),
          }),
        );
        return;
      }
      if (mediaRefreshAttemptedRef.current || mediaRefreshInFlightRef.current) {
        setError(intl.formatMessage({ id: "codeViewer.mediaLoadFailed" }));
        return;
      }

      mediaRefreshAttemptedRef.current = true;
      const generation = mediaPreviewGenerationRef.current;
      mediaPlaybackRestoreRef.current = {
        currentTime: Number.isFinite(mediaElement.currentTime) ? mediaElement.currentTime : 0,
        paused: mediaElement.paused,
        volume: mediaElement.volume,
        muted: mediaElement.muted,
      };
      setError(null);
      mediaRefreshTimerRef.current = setTimeout(() => {
        mediaRefreshTimerRef.current = null;
        if (generation !== mediaPreviewGenerationRef.current) return;
        mediaRefreshInFlightRef.current = true;
        void refreshPlaybackUrl({ previewId: mediaPreviewId })
          .then(({ url }) => {
            if (generation === mediaPreviewGenerationRef.current) setMediaPreviewUrl(url);
          })
          .catch(() => {
            if (generation === mediaPreviewGenerationRef.current) {
              setError(intl.formatMessage({ id: "codeViewer.mediaLoadFailed" }));
            }
          })
          .finally(() => {
            mediaRefreshInFlightRef.current = false;
          });
      }, 500);
    },
    [intl, mediaPreviewId, mediaPreviewService],
  );

  const handleMediaLoadedMetadata = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const restore = mediaPlaybackRestoreRef.current;
    if (!restore) return;
    const mediaElement = event.currentTarget;
    mediaElement.volume = restore.volume;
    mediaElement.muted = restore.muted;
    try {
      mediaElement.currentTime = restore.currentTime;
    } catch {
      // 媒体元数据尚未完全就绪时由浏览器稍后继续处理，不阻断播放器加载。
    }
    if (!restore.paused) void mediaElement.play().catch(() => undefined);
    mediaPlaybackRestoreRef.current = null;
  }, []);

  const handlePreviewContentScroll = useCallback(() => {
    rememberScrollMetrics();
  }, [rememberScrollMetrics]);

  useLayoutEffect(() => {
    if (!renderHeavyContent) {
      return;
    }

    if (!previousRenderHeavyContentRef.current) {
      return;
    }

    rememberScrollMetrics();
  }, [filePreview, rememberScrollMetrics, renderHeavyContent, source]);

  useLayoutEffect(() => {
    const wasRenderingHeavyContent = previousRenderHeavyContentRef.current;
    previousRenderHeavyContentRef.current = renderHeavyContent;

    if (!renderHeavyContent) {
      return;
    }

    if (wasRenderingHeavyContent) {
      return;
    }

    const container = scrollContainerRef.current;
    const preservedScrollTop = preservedScrollMetricsRef.current.scrollTop;
    if (!container || preservedScrollTop <= 0) {
      return;
    }

    const frameId = requestAnimationFrame(() => {
      container.scrollTop = Math.min(
        preservedScrollTop,
        Math.max(0, container.scrollHeight - container.clientHeight),
      );
    });

    return () => {
      cancelAnimationFrame(frameId);
    };
  }, [renderHeavyContent, source]);

  if (!source) {
    return null;
  }

  const handleOpenDiffFilePreview = () => {
    if (!diffFilePreviewSource) {
      return;
    }

    onOpenCodeViewer?.(diffFilePreviewSource);
  };

  const deferredBodyStyle: CSSProperties | undefined =
    !renderHeavyContent && preservedScrollMetricsRef.current.scrollHeight > 0
      ? {
          height: `${preservedScrollMetricsRef.current.scrollHeight}px`,
        }
      : undefined;

  const viewMenuItems = hasMoreMenu ? (
    <>
      {canToggleMarkdownView ? (
        <>
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "codeViewer.markdownMode" })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={markdownViewMode}
            onValueChange={(value) => {
              setMarkdownViewMode(value as "preview" | "code");
            }}
          >
            <DropdownMenuRadioItem value="preview">
              <EyeIcon className="size-4" />
              {intl.formatMessage({
                id: "codeViewer.markdownPreview",
              })}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="code">
              <FileCode2Icon className="size-4" />
              {intl.formatMessage({
                id: "codeViewer.markdownSource",
              })}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </>
      ) : null}
      {canToggleSvgView ? (
        <>
          {canToggleMarkdownView ? <DropdownMenuSeparator /> : null}
          <DropdownMenuLabel>{intl.formatMessage({ id: "codeViewer.svgMode" })}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={svgViewMode}
            onValueChange={(value) => {
              setSvgViewMode(value as "preview" | "code");
            }}
          >
            <DropdownMenuRadioItem value="preview">
              <EyeIcon className="size-4" />
              {intl.formatMessage({ id: "codeViewer.svgPreview" })}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="code">
              <FileCode2Icon className="size-4" />
              {intl.formatMessage({ id: "codeViewer.svgSource" })}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </>
      ) : null}
      {canToggleCodeWrap ? (
        <>
          {canToggleMarkdownView || canToggleSvgView ? <DropdownMenuSeparator /> : null}
          <DropdownMenuCheckboxItem
            checked={wrapLongLines}
            onCheckedChange={(checked) => {
              setWrapLongLinesOverride(Boolean(checked));
            }}
          >
            <FileCode2Icon className="size-4" />
            {intl.formatMessage({ id: "codeViewer.wrapLines" })}
          </DropdownMenuCheckboxItem>
        </>
      ) : null}
    </>
  ) : null;

  const header = (
    <div
      className={cn(
        "flex h-10 min-w-0 shrink-0 items-center gap-2",
        !headerContainer && "bg-surface/30",
        !headerContainer && showDocumentHeaderDivider && "border-b border-border",
      )}
    >
      <div
        ref={breadcrumbScrollRef}
        className={cn(
          "min-w-0 flex-1 overflow-x-auto !scrollbar-hide",
          BREADCRUMB_MASK_CLASS_BY_STATE[breadcrumbMaskState],
        )}
      >
        <div
          ref={breadcrumbContentRef}
          className="flex min-w-max items-center px-3 gap-0.5 text-ui-base text-foreground-subtle"
        >
          {breadcrumb?.rootLabel ? (
            <span className="shrink-0 text-foreground-subtle">{breadcrumb.rootLabel}</span>
          ) : null}
          {breadcrumb?.rootLabel ? (
            <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
          ) : null}
          {breadcrumb?.parentSegments.map((segment, index) => (
            <Fragment key={`${segment}-${index}`}>
              <span className="shrink-0">{segment}</span>
              <ChevronRightIcon className="size-3.5 shrink-0 text-foreground-subtlest" />
            </Fragment>
          ))}

          <span className="inline-flex min-w-0 items-center gap-1 text-foreground">
            {breadcrumb?.fileIconSrc ? (
              <FileDisplayIcon src={breadcrumb.fileIconSrc} size={14} className="shrink-0" />
            ) : null}
            <span className="truncate">{breadcrumb?.fileLabel ?? source.title}</span>
          </span>
        </div>
      </div>

      <div className="flex shrink-0 pr-1.5 items-center gap-2">
        {canOpenDiffFilePreview ? (
          <Button
            type="button"
            size="default"
            variant="ghost"
            className="shrink-0 rounded-lg text-foreground-subtle hover:text-foreground"
            data-diff-source-preview-trigger
            onClick={handleOpenDiffFilePreview}
            title={intl.formatMessage({
              id: "codeViewer.openSourcePreview",
            })}
            aria-label={intl.formatMessage({
              id: "codeViewer.openSourcePreview",
            })}
          >
            <FileCode2Icon className="size-3.5" data-icon="inline-start" />
            <span>
              {intl.formatMessage({
                id: "codeViewer.openSourcePreview",
              })}
            </span>
          </Button>
        ) : null}
        {/* 无路径内容没有文件动作；保留唯一的视图入口。有路径文件统一收进 Open 下拉。 */}
        {!source.path && viewMenuItems ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={intl.formatMessage({ id: "common.more" })}
                title={intl.formatMessage({ id: "common.more" })}
              >
                <Ellipsis className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)]">
              {viewMenuItems}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        {source.path && (
          <OpenSplitButton
            openDefaultOnPrimary
            viewMenuItems={viewMenuItems}
            target={{
              type: "file",
              path: source.path,
              title: source.title,
              label: getPathLeaf(source.path),
              // 文件菜单沿用预览已解析的工作区，避免仅传入外层 workspacePath 时丢失来源。
              previewSource: { ...source, workspacePath: sourceWorkspacePath },
            }}
            onOpenCodeViewer={onOpenCodeViewer}
          />
        )}
      </div>
    </div>
  );

  return (
    <aside
      data-testid={TID_PREVIEW_PANE}
      className="flex h-full flex-col overflow-hidden bg-background"
    >
      {headerContainer ? createPortal(header, headerContainer) : header}
      <div className="min-h-0 flex-1">
        {renderHeavyContent ? (
          <PreviewPaneContent
            source={imageSource ?? mediaSource ?? source}
            filePreview={filePreview}
            fileTooLarge={fileTooLarge}
            loadingInitial={loadingInitial}
            loadingImagePreview={loadingImagePreview}
            imagePreview={imagePreview}
            imageFileReference={imageFileReference}
            loadImageDownloadSource={sourceFilePath ? loadImageDownloadSource : undefined}
            mediaSource={mediaSource}
            loadingMediaPreview={loadingMediaPreview}
            mediaPreviewUrl={mediaPreviewUrl}
            onMediaError={handleMediaError}
            onMediaLoadedMetadata={handleMediaLoadedMetadata}
            error={error}
            codePreviewSettings={codePreviewSettings}
            codeTheme={codeTheme}
            resolvedTheme={resolvedTheme}
            theme={theme}
            workspacePath={sourceWorkspacePath}
            onOpenBrowserUrl={onOpenBrowserUrl}
            markdownSelectionTarget={
              markdownSelectionTarget &&
              (source.workspaceIdentity?.trim() || sourceWorkspacePath) ===
                markdownSelectionTarget.workspaceKey
                ? markdownSelectionTarget
                : undefined
            }
            markdownViewMode={markdownViewMode}
            svgViewMode={svgViewMode}
            wrapLongLines={wrapLongLines}
            codeComments={codeComments}
            enableCodeLineSelection={canCreateCodeComment}
            enableCodeGutterUtility={canCreateCodeComment}
            codeCommentLabels={codeCommentLabels}
            onSubmitCodeComment={handleSubmitCodeComment}
            onDeleteCodeComment={handleDeleteCodeComment}
            // PreviewPane 外层只是 flex 壳，真实滚动发生在具体内容组件的 overflow 容器。
            // 折叠侧边面板卸载重内容前必须保存该容器的位置。
            onScroll={handlePreviewContentScroll}
            scrollContainerRef={scrollContainerRef}
          />
        ) : (
          <PreviewPaneDeferredHeavyContent style={deferredBodyStyle} />
        )}
      </div>
    </aside>
  );
}
