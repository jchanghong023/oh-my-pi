import type { ReactElement } from "react";

export interface PdfViewerLabels {
  loading: string;
  loadError: string;
  noData: string;
  previousPage: string;
  nextPage: string;
  pageInput: string;
  zoomIn: string;
  zoomOut: string;
}

export interface PdfViewerRangeSource {
  totalBytes: number;
  initialData?: Uint8Array;
  requestRange: (offset: number, limit: number) => Promise<Uint8Array>;
}

export type PdfViewerSource = string | Uint8Array | PdfViewerRangeSource;

/** Minimal WebGUI ships no pdf.js; callers get an honest unavailable state. */
export function PdfViewer({
  className,
  labels,
}: {
  source: PdfViewerSource;
  className?: string;
  labels?: Partial<PdfViewerLabels>;
}): ReactElement {
  return (
    <div className={className} role="status">
      {labels?.loadError ?? "PDF preview is unavailable in the minimal WebUI."}
    </div>
  );
}
