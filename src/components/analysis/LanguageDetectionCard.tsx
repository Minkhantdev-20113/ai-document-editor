import { useState } from 'react';
import { LANGUAGES, languageLabel } from '../../config/languages';
import type { DocumentRecord } from '../../db/entities';
import { LANGUAGE_CONFIRM_THRESHOLD } from '../../domain/analysis/ir';
import { useT } from '../../i18n/I18nProvider';
import { Button } from '../ui/Button';
import { Select } from '../ui/Form';
import { Notice } from '../ui/Notice';
import { Badge } from '../ui/StatusBadge';

/**
 * Source-language detection result with the user's confirmation flow:
 * when confidence is below the confirm threshold (or detection failed) the
 * card asks the visitor to pick the language explicitly.
 */
export function LanguageDetectionCard({
  document,
  onConfirm,
}: {
  readonly document: DocumentRecord;
  readonly onConfirm: (code: string) => void;
}) {
  const t = useT();
  const detection = document.languageDetection ?? null;
  const detectedCode = detection && detection.code !== 'unknown' ? detection.code : null;
  const needsConfirmation =
    detectedCode === null || detection === null || detection.confidence < LANGUAGE_CONFIRM_THRESHOLD;

  // `null` means "not touched yet": the select follows whatever detection (or
  // the stored source language) currently suggests, so no effect is needed.
  const [choice, setChoice] = useState<string | null>(null);
  const fallback = detectedCode ?? document.sourceLanguage;
  const value = choice ?? fallback;

  const scores = detection
    ? Object.entries(detection.scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];
  const percent = detection ? Math.round(detection.confidence * 100) : 0;

  return (
    <div className="stack stack-3">
      {detectedCode ? (
        <p className="muted">{t('analysis.detected', { label: languageLabel(detectedCode), percent })}</p>
      ) : (
        <p className="muted">{t('analysis.undetected')}</p>
      )}

      {scores.length > 0 && (
        <div className="row row-2">
          {scores.map(([code, score]) => (
            <Badge key={code} tone={code === detection?.code ? 'primary' : 'neutral'}>
              {languageLabel(code)} · {Math.round(score * 100)}%
            </Badge>
          ))}
        </div>
      )}

      {needsConfirmation ? (
        <>
          <Notice tone="warning">
            {detectedCode === null ? t('analysis.undetected') : t('analysis.lowConfidence')}
          </Notice>
          <div className="row row-2">
            <Select
              options={LANGUAGES.map((language) => ({ value: language.code, label: languageLabel(language.code) }))}
              value={value}
              onChange={(event) => setChoice(event.target.value)}
              aria-label={t('analysis.languageTitle')}
            />
            <Button variant="primary" disabled={!value} onClick={() => onConfirm(value)}>
              {t('analysis.confirmLanguage')}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs subtle">
          {t('analysis.languageTitle')}: {languageLabel(document.sourceLanguage)}
        </p>
      )}
    </div>
  );
}
