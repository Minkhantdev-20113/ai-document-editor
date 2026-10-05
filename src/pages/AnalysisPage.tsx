import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ROUTES } from '../config/appConfig';
import { toAppError } from '../core/errors/appError';
import { formatDateTime } from '../core/utils/time';
import type { DocumentPage, DocumentRecord, Project } from '../db/entities';
import { useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useJobs } from '../hooks/useJobs';
import { useT } from '../i18n/I18nProvider';
import { startInspectionById } from '../jobs/actions';
import { documentService } from '../services/documentService';
import { projectService } from '../services/projectService';
import { useToast } from '../state/ToastProvider';
import { AnalysisMetadataCard } from '../components/analysis/AnalysisMetadataCard';
import { AnalysisStageList } from '../components/analysis/AnalysisStageList';
import { BlockTable } from '../components/analysis/BlockTable';
import { LanguageDetectionCard } from '../components/analysis/LanguageDetectionCard';
import { OcrPanel } from '../components/analysis/OcrPanel';
import { PageStatusGrid } from '../components/analysis/PageStatusGrid';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { ProgressBar } from '../components/ui/Progress';

interface AnalysisData {
  readonly project: Project | undefined;
  readonly document: DocumentRecord | undefined;
  readonly pages: DocumentPage[];
}

/**
 * Phase 2 analysis view: live pipeline progress (stage, task, page x/y),
 * persisted page/block structure, language detection with confirmation,
 * metadata, per-page failure reporting, and the honest OCR notice.
 */
export function AnalysisPage() {
  const { projectId } = useParams();
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('analysis.title'));

  const { data, loading } = useCollection<AnalysisData>(
    async () => {
      const project = projectId ? await projectService.get(projectId) : undefined;
      const document = project?.documentId ? await documentService.get(project.documentId) : undefined;
      const pages = document ? await documentService.pages(document.id) : [];
      return { project, document, pages };
    },
    [projectId],
    ['projects:changed', 'documents:changed', 'pages:changed', 'analysis:progress', 'units:changed'],
  );

  const project = data?.project;
  const document = data?.document;
  const pages = data?.pages ?? [];

  // User choice wins as long as it still exists; otherwise fall back to the
  // first analyzed page. Derived during render so no effect is needed.
  const [userSelection, setUserSelection] = useState<string | null>(null);
  const selectedPageId =
    userSelection !== null && pages.some((page) => page.id === userSelection)
      ? userSelection
      : (pages.find((page) => page.analyzedAt !== undefined) ?? pages[0])?.id ?? null;

  const { data: blocks } = useCollection(
    async () => (selectedPageId ? documentService.blocksOfPage(selectedPageId) : []),
    [selectedPageId],
    ['pages:changed', 'units:changed'],
  );

  const { data: jobs } = useJobs(projectId ? { projectId } : {});
  const activeStates = useMemo(
    () => new Set(['analyzing', 'translating', 'exporting', 'retrying', 'queued']),
    [],
  );
  const inspectBusy = (jobs ?? []).some(
    (job) => job.type === 'inspect_document' && activeStates.has(job.state),
  );

  async function handleRerun() {
    if (!project) return;
    try {
      await startInspectionById(project.id);
      toast.info(t('workspace.inspecting'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  async function handleConfirmLanguage(code: string) {
    if (!project || !document) return;
    try {
      await projectService.update(project.id, { sourceLanguage: code });
      await documentService.confirmSourceLanguage(document.id, code);
      toast.success(t('analysis.languageConfirmed'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    }
  }

  if (loading && !data) {
    return (
      <div className="page">
        <PageHeader title={t('analysis.title')} subtitle={t('analysis.subtitle')} />
        <p className="muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (!project || !document) {
    return (
      <div className="page">
        <PageHeader title={t('analysis.title')} subtitle={t('analysis.subtitle')} />
        <EmptyState
          icon="fileText"
          title={t('projects.noFile')}
          body={t('analysis.emptyHint')}
          action={
            <ButtonLink to={ROUTES.workspace} variant="primary">
              {t('nav.workspace')}
            </ButtonLink>
          }
        />
      </div>
    );
  }

  const analysis = document.analysis ?? null;
  const hasRun = analysis !== null || pages.some((page) => page.analyzedAt !== undefined);
  const failedPages = pages.filter((page) => page.status === 'failed');
  const needsOcrPages = pages.filter((page) => page.status === 'needs_ocr');
  const unitCount = pages.reduce((sum, page) => sum + page.unitCount, 0);
  const processed = analysis?.processedPages ?? 0;
  const totalPages = analysis?.totalPages ?? document.pageCount ?? 0;
  const percent = totalPages > 0 ? Math.round((processed / totalPages) * 100) : 0;
  const selectedPage = pages.find((page) => page.id === selectedPageId) ?? null;

  return (
    <div className="page page--wide analysis-page">
      <PageHeader
        title={t('analysis.title')}
        subtitle={t('analysis.subtitle')}
        actions={
          <div className="row row-2">
            <ButtonLink to={ROUTES.workspaceProject(project.id)} variant="ghost">
              {t('workspace.title')}
            </ButtonLink>
            <Button
              variant="primary"
              icon={<Icon name="refresh" size={14} />}
              loading={inspectBusy}
              disabled={!document.payloadStored}
              onClick={() => void handleRerun()}
            >
              {t('analysis.rerun')}
            </Button>
          </div>
        }
      />

      {!hasRun ? (
        <EmptyState
          icon="fileText"
          title={t('analysis.emptyTitle')}
          body={t('analysis.emptyHint')}
          action={
            <Button
              variant="primary"
              loading={inspectBusy}
              disabled={!document.payloadStored}
              onClick={() => void handleRerun()}
            >
              {t('workspace.inspect')}
            </Button>
          }
        />
      ) : (
        <div className="stack stack-6">
          <Card title={t('analysis.runTitle')} subtitle={t('analysis.rerunHint')}>
            <div className="stack stack-4">
              <ProgressBar
                value={percent}
                label={t('analysis.pagesProgress', { done: processed, total: totalPages })}
              />
              <div className="overview-grid">
                <div className="stat">
                  <span className="stat__label">{t('analysis.stage')}</span>
                  <span className="stat__value" style={{ fontSize: 'var(--text-md)' }}>
                    {t(`analysis.stageNames.${analysis?.stage ?? 'validating'}`)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat__label">{t('analysis.task')}</span>
                  <span className="stat__value" style={{ fontSize: 'var(--text-md)' }}>
                    {t(`analysis.taskNames.${analysis?.task ?? 'idle'}`)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat__label">{t('analysis.statPages')}</span>
                  <span className="stat__value">
                    {processed} / {totalPages}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat__label">{t('analysis.statBlocks')}</span>
                  <span className="stat__value">{analysis?.blocks ?? 0}</span>
                </div>
                <div className="stat">
                  <span className="stat__label">{t('analysis.statUnits')}</span>
                  <span className="stat__value">{unitCount}</span>
                </div>
                <div className="stat">
                  <span className="stat__label">{t('analysis.statFailed')}</span>
                  <span className="stat__value">{analysis?.failedPages ?? 0}</span>
                </div>
              </div>
              <AnalysisStageList stage={analysis?.stage} task={analysis?.task} />
              <p className="text-xs subtle">
                {t('analysis.startedAt')}: {formatDateTime(analysis?.startedAt ?? document.createdAt)} ·{' '}
                {t('analysis.updatedAt')}: {formatDateTime(analysis?.updatedAt ?? document.updatedAt)}
              </p>
            </div>
          </Card>

          {failedPages.length > 0 && (
            <Notice tone="warning">
              {t('analysis.failedBody', { pages: failedPages.map((page) => page.pageIndex + 1).join(', ') })}
            </Notice>
          )}

          {needsOcrPages.length > 0 && (
            <Card title={t('analysis.ocrTitle')}>
              <OcrPanel pages={needsOcrPages} />
            </Card>
          )}

          <div className="analysis-columns">
            <Card title={t('analysis.languageTitle')}>
              <LanguageDetectionCard document={document} onConfirm={(code) => void handleConfirmLanguage(code)} />
            </Card>
            <Card title={t('analysis.metadataTitle')}>
              <AnalysisMetadataCard metadata={document.metadata ?? null} />
            </Card>
          </div>

          {pages.length > 0 && (
            <>
              <Card title={t('analysis.pagesTitle')} subtitle={t('analysis.pagesHint')}>
                <PageStatusGrid
                  pages={pages}
                  selectedPageId={selectedPageId}
                  onSelect={setUserSelection}
                />
              </Card>

              <Card
                title={
                  selectedPage
                    ? t('analysis.blocksTitle', { page: selectedPage.pageIndex + 1 })
                    : t('analysis.blocksHint')
                }
              >
                {selectedPage ? (
                  <BlockTable blocks={blocks ?? []} />
                ) : (
                  <EmptyState icon="fileText" title={t('analysis.blocksHint')} />
                )}
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
