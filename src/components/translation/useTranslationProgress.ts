import { useEffect, useState } from 'react';
import { appEvents, type AppEventMap } from '../../core/events/eventBus';

export type TranslationProgressEvent = AppEventMap['translation:progress'];

/**
 * Live progress for one document's translation run. The stored entry carries
 * the document id it belongs to, so switching documents derives `null` during
 * render (no effect-body reset) until the new document emits its first tick.
 */
export function useTranslationProgress(documentId: string): TranslationProgressEvent | null {
  const [entry, setEntry] = useState<{ id: string; progress: TranslationProgressEvent } | null>(
    null,
  );
  useEffect(() => {
    return appEvents.on('translation:progress', (payload) => {
      if (payload.documentId === documentId) {
        setEntry({ id: payload.documentId, progress: payload });
      }
    });
  }, [documentId]);
  return entry && entry.id === documentId ? entry.progress : null;
}
