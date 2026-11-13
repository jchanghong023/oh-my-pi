import { useMemo } from "react";
import type { PdfViewerLabels } from "@/components/ui/pdf-viewer.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 重量级叶子查看器（PDF）的本地化标签：`PreviewPane` 与 `workflow-artifact` tab 共用同一批
 * `codeViewer.*` 文案，避免漏译或漏键。
 */
export function usePdfViewerLabels(): PdfViewerLabels {
  const { intl } = useZCodeIntl();
  return useMemo(
    () => ({
      loading: intl.formatMessage({ id: "codeViewer.pdf.loading" }),
      loadError: intl.formatMessage({ id: "codeViewer.pdf.loadError" }),
      noData: intl.formatMessage({ id: "codeViewer.pdf.noData" }),
      previousPage: intl.formatMessage({ id: "codeViewer.pdf.previousPage" }),
      nextPage: intl.formatMessage({ id: "codeViewer.pdf.nextPage" }),
      pageInput: intl.formatMessage({ id: "codeViewer.pdf.pageInput" }),
      zoomIn: intl.formatMessage({ id: "codeViewer.pdf.zoomIn" }),
      zoomOut: intl.formatMessage({ id: "codeViewer.pdf.zoomOut" }),
    }),
    [intl],
  );
}
