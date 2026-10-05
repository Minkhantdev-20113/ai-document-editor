import type { ExportFormat } from '../../config/appConfig';

/**
 * Hands an in-memory artifact to the browser's download manager.
 *
 * Used by the export flow (Phase 5): the file itself was produced and
 * validated in the worker, so the only main-thread work left is a Blob, an
 * object URL and a synthetic click.
 */
export function downloadBytes(
  fileName: string,
  bytes: ArrayBuffer | Uint8Array,
  mimeType: string,
): void {
  const blob = new Blob([bytes as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke once the browser has taken the URL (a tick is enough).
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

/** MIME type written into the produced Blob per export format. */
export function mimeTypeForFormat(format: ExportFormat): string {
  switch (format) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'html':
      return 'text/html;charset=utf-8';
    case 'json':
      return 'application/json;charset=utf-8';
    case 'txt':
      return 'text/plain;charset=utf-8';
    case 'md':
      return 'text/markdown;charset=utf-8';
  }
}
