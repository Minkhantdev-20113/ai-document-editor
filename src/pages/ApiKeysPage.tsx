import { useState } from 'react';
import { AppError, toAppError } from '../core/errors/appError';
import { formatDateTime } from '../core/utils/time';
import type { ApiKeyMetadata } from '../db/entities';
import { getProviderDescriptor, listProviderDescriptors, looksLikeKey } from '../providers/registry';
import { isProviderId, type ProviderId } from '../providers/types';
import { apiKeyService } from '../services/apiKeyService';
import { keyVault, type VaultStatus } from '../security/keyVault';
import { useAsyncData, useCollection } from '../hooks/useAsyncData';
import { useDocumentTitle } from '../hooks/useSystem';
import { useT } from '../i18n/I18nProvider';
import { useToast } from '../state/ToastProvider';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';
import { Input, Select } from '../components/ui/Form';
import { Notice } from '../components/ui/Notice';
import { PageHeader } from '../components/ui/PageHeader';
import { ApiKeyStatusBadge } from '../components/ui/StatusBadge';
import { KeyPoolCard } from '../components/providers/KeyPoolCard';

const PROVIDER_OPTIONS = listProviderDescriptors().map((descriptor) => ({
  value: descriptor.id,
  label: descriptor.label,
}));

/**
 * Provider label for a *stored* row.
 *
 * Rows written before a provider was dropped (DeepSeek in 0.6.0) have no
 * descriptor any more. Bootstrap removes them, but the table must not throw
 * while that is still pending, nor after an older data bundle reintroduces
 * one - so an unknown provider shows its raw id instead of crashing the page.
 */
function keyProviderLabel(providerId: string): string {
  return isProviderId(providerId) ? getProviderDescriptor(providerId).label : providerId;
}

/** API keys: encrypted locally, verified on demand, never rendered in full. */
export function ApiKeysPage() {
  const t = useT();
  const toast = useToast();
  useDocumentTitle(t('apiKeys.title'));

  const { data: keys, reload: reloadKeys } = useCollection<ApiKeyMetadata[]>(
    () => apiKeyService.list(),
    [],
    ['apiKeys:changed'],
  );
  const { data: vault, reload: reloadVault } = useAsyncData<VaultStatus>(
    async () => {
      await keyVault.ready();
      return keyVault.status();
    },
    [],
    {},
  );

  const [adding, setAdding] = useState(false);
  const [providerId, setProviderId] = useState<ProviderId>('gemini');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null);
  const [unlockValue, setUnlockValue] = useState('');
  const [pendingRevoke, setPendingRevoke] = useState<ApiKeyMetadata | null>(null);
  const [passphraseOpen, setPassphraseOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [passphraseError, setPassphraseError] = useState<string | null>(null);
  const [passphraseRemoving, setPassphraseRemoving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    if (!looksLikeKey(providerId, secret)) {
      setAddError(t('apiKeys.formatInvalid', { provider: getProviderDescriptor(providerId).label }));
      return;
    }
    setAddError(null);
    setBusy(true);
    try {
      await apiKeyService.add({ providerId, label, key: secret });
      setAdding(false);
      setSecret('');
      setLabel('');
      toast.success(t('apiKeys.addedToast'));
      reloadKeys();
    } catch (error) {
      setAddError(t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(id: string) {
    setBusyKeyId(id);
    try {
      const result = await apiKeyService.verify(id);
      if (result.ok) {
        toast.success(t('apiKeys.verifiedToast'));
      } else {
        toast.error(t('apiKeys.verifyFailed'), t(`errors.${result.error.code}`));
      }
      reloadKeys();
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleCopy(id: string) {
    setBusyKeyId(id);
    try {
      await apiKeyService.copyToClipboard(id);
      toast.success(t('common.copied'));
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusyKeyId(null);
    }
  }

  async function handleRevoke() {
    if (!pendingRevoke) return;
    setBusy(true);
    try {
      await apiKeyService.remove(pendingRevoke.id);
      toast.success(t('apiKeys.revokedToast'));
      setPendingRevoke(null);
      reloadKeys();
      reloadVault();
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlock() {
    setBusy(true);
    try {
      const ok = await keyVault.unlock(unlockValue);
      if (!ok) {
        throw new AppError(t('apiKeys.wrongPassphrase'), { code: 'vault_wrong_passphrase', retryable: false });
      }
      setUnlockValue('');
      toast.success(t('apiKeys.vaultUnlocked'));
      reloadVault();
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetPassphrase() {
    if (passphrase.length < 8) {
      setPassphraseError(t('apiKeys.passphraseHint'));
      return;
    }
    if (passphrase !== passphraseConfirm) {
      setPassphraseError(t('apiKeys.passphraseMismatch'));
      return;
    }
    setPassphraseError(null);
    setBusy(true);
    try {
      await keyVault.setPassphrase(passphrase);
      setPassphraseOpen(false);
      setPassphrase('');
      setPassphraseConfirm('');
      toast.success(t('apiKeys.passphraseSetToast'));
      reloadVault();
    } catch (error) {
      setPassphraseError(t(`errors.${toAppError(error).code}`));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemovePassphrase() {
    setPassphraseRemoving(true);
    try {
      await keyVault.removePassphrase();
      toast.success(t('apiKeys.passphraseRemovedToast'));
      reloadVault();
    } catch (error) {
      toast.error(t('toast.error'), t(`errors.${toAppError(error).code}`));
    } finally {
      setPassphraseRemoving(false);
    }
  }

  const unlocked = vault?.unlocked ?? false;
  const formatLooksValid = secret.trim() === '' || looksLikeKey(providerId, secret);
  // One failover-pool card per provider that actually has keys stored.
  const poolProviders = listProviderDescriptors()
    .filter((descriptor) => (keys ?? []).some((key) => key.providerId === descriptor.id))
    .map((descriptor) => descriptor.id);

  return (
    <div className="page">
      <PageHeader
        title={t('apiKeys.title')}
        subtitle={t('apiKeys.subtitle')}
        actions={
          <Button
            variant="primary"
            icon={<Icon name="plus" size={14} />}
            onClick={() => {
              setAddError(null);
              setAdding(true);
            }}
            disabled={!unlocked}
            title={unlocked ? undefined : t('errors.vault_locked')}
          >
            {t('apiKeys.add')}
          </Button>
        }
      />

      <Notice tone="warning" icon="shield">
        {t('apiKeys.byokCaveat')}
      </Notice>

      <Card title={t('apiKeys.vault')}>
        <div className="stack stack-4">
          <div className="overview-grid">
            <div className="stat">
              <span className="stat__label">{t('apiKeys.vaultMode')}</span>
              <span className="stat__value" style={{ fontSize: 'var(--text-md)' }}>
                {vault?.mode === 'passphrase' ? t('apiKeys.vaultPassphrase') : t('apiKeys.vaultDevice')}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('apiKeys.vault')}</span>
              <span className="stat__value" style={{ fontSize: 'var(--text-md)' }}>
                {unlocked ? t('apiKeys.vaultUnlocked') : t('apiKeys.vaultLocked')}
              </span>
            </div>
            <div className="stat">
              <span className="stat__label">{t('apiKeys.secretCount', { count: vault?.secretCount ?? 0 })}</span>
              <span className="stat__value">{vault?.secretCount ?? 0}</span>
            </div>
          </div>

          <p className="text-xs muted">
            {vault?.mode === 'passphrase' ? t('apiKeys.vaultPassphraseHint') : t('apiKeys.vaultDeviceHint')}
          </p>

          <div className="row row-2">
            {unlocked ? (
              <Button icon={<Icon name="lock" size={14} />} onClick={() => { keyVault.lock(); reloadVault(); }}>
                {t('apiKeys.vaultLock')}
              </Button>
            ) : (
              <div className="row row-2">
                <Input
                  type="password"
                  placeholder={t('apiKeys.unlockPassphrase')}
                  value={unlockValue}
                  onChange={(event) => setUnlockValue(event.target.value)}
                  disabled={vault?.mode !== 'passphrase'}
                />
                <Button variant="primary" loading={busy} onClick={() => void handleUnlock()}>
                  {t('apiKeys.vaultUnlock')}
                </Button>
              </div>
            )}
            {vault?.mode === 'passphrase' ? (
              <Button variant="danger" loading={passphraseRemoving} onClick={() => void handleRemovePassphrase()}>
                {t('apiKeys.removePassphrase')}
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setPassphraseError(null);
                  setPassphraseOpen(true);
                }}
              >
                {t('apiKeys.setPassphrase')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card title={t('apiKeys.title')} subtitle={t('apiKeys.secretCount', { count: keys?.length ?? 0 })}>
        {(keys ?? []).length === 0 ? (
          <EmptyState
            icon="key"
            title={t('apiKeys.empty')}
            body={t('apiKeys.emptyHint')}
            action={
              <Button
                variant="primary"
                disabled={!unlocked}
                icon={<Icon name="plus" size={14} />}
                onClick={() => {
                  setAddError(null);
                  setAdding(true);
                }}
              >
                {t('apiKeys.add')}
              </Button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('apiKeys.label')}</th>
                  <th>{t('apiKeys.provider')}</th>
                  <th>{t('apiKeys.keyValue')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('apiKeys.lastVerified')}</th>
                  <th aria-label={t('common.actions')} />
                </tr>
              </thead>
              <tbody>
                {(keys ?? []).map((key) => (
                  <tr key={key.id}>
                    <td className="truncate">{key.label}</td>
                    <td>{keyProviderLabel(key.providerId)}</td>
                    <td className="mono text-xs">{key.hint}</td>
                    <td><ApiKeyStatusBadge status={key.status} /></td>
                    <td className="text-xs nowrap">
                      {key.lastVerifiedAt ? formatDateTime(key.lastVerifiedAt) : t('common.never')}
                    </td>
                    <td>
                      <div className="row row-2" style={{ justifyContent: 'flex-end' }}>
                        <Button
                          size="sm"
                          loading={busyKeyId === key.id}
                          disabled={!unlocked}
                          onClick={() => void handleVerify(key.id)}
                        >
                          {t('apiKeys.verify')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Icon name="copy" size={13} />}
                          disabled={!unlocked}
                          onClick={() => void handleCopy(key.id)}
                        >
                          {t('common.copy')}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<Icon name="trash" size={13} />}
                          onClick={() => setPendingRevoke(key)}
                        >
                          {t('apiKeys.revoke')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Notice tone="info" icon="shield">
        {t('apiKeys.addHint')}
      </Notice>

      {poolProviders.length > 0 && (
        <Card title={t('keyPool.title')} subtitle={t('keyPool.subtitle')}>
          <div className="stack stack-6">
            {poolProviders.map((providerId) => (
              <KeyPoolCard key={providerId} providerId={providerId} />
            ))}
          </div>
        </Card>
      )}

      <Modal
        open={adding}
        title={t('apiKeys.addTitle')}
        description={t('apiKeys.addHint')}
        onClose={() => setAdding(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!secret.trim() || !formatLooksValid}
              onClick={() => void handleAdd()}
            >
              {t('common.add')}
            </Button>
          </>
        }
      >
        <div className="stack stack-4">
          {addError && <Notice tone="warning">{addError}</Notice>}
          <Select
            label={t('apiKeys.provider')}
            value={providerId}
            onChange={(event) => setProviderId(event.target.value as ProviderId)}
            options={PROVIDER_OPTIONS}
          />
          <Input
            label={t('apiKeys.label')}
            placeholder={t('apiKeys.labelPlaceholder')}
            value={label}
            optional
            onChange={(event) => setLabel(event.target.value)}
          />
          <div className="stack stack-2">
            <div className="row row-2">
              <div style={{ flex: '1 1 auto' }}>
                <Input
                  type={showSecret ? 'text' : 'password'}
                  label={t('apiKeys.keyValue')}
                  placeholder={t('apiKeys.keyValuePlaceholder')}
                  value={secret}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </div>
              <Button
                icon={<Icon name={showSecret ? 'eyeOff' : 'eye'} size={14} />}
                onClick={() => setShowSecret((value) => !value)}
                style={{ marginBottom: 6 }}
              >
                {showSecret ? t('apiKeys.hideKey') : t('apiKeys.showKey')}
              </Button>
            </div>
            {secret.trim() !== '' && (
              <span className={formatLooksValid ? 'field__hint' : 'field__error'}>
                {formatLooksValid
                  ? t('apiKeys.formatHint')
                  : t('apiKeys.formatInvalid', { provider: getProviderDescriptor(providerId).label })}
              </span>
            )}
          </div>
        </div>
      </Modal>

      <Modal
        open={passphraseOpen}
        title={t('apiKeys.setPassphrase')}
        description={t('apiKeys.passphraseHint')}
        onClose={() => setPassphraseOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPassphraseOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void handleSetPassphrase()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="stack stack-4">
          {passphraseError && <Notice tone="warning">{passphraseError}</Notice>}
          <Input
            type="password"
            label={t('apiKeys.passphrase')}
            hint={t('apiKeys.passphraseHint')}
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          <Input
            type="password"
            label={t('apiKeys.confirmPassword')}
            value={passphraseConfirm}
            onChange={(event) => setPassphraseConfirm(event.target.value)}
          />
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingRevoke !== null}
        title={t('apiKeys.revokeConfirmTitle')}
        body={t('apiKeys.revokeConfirmBody')}
        confirmLabel={t('apiKeys.revoke')}
        destructive
        busy={busy}
        onConfirm={() => void handleRevoke()}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
