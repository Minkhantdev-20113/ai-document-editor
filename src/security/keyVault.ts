import { LOCAL_STORAGE_KEYS, VAULT_DEFAULTS } from '../config/appConfig';
import { AppError, toAppError } from '../core/errors/appError';
import { appEvents } from '../core/events/eventBus';
import { logger } from '../core/logging/logger';
import { secretsRepo } from '../db/repositories';
import type { SecretRecord } from '../db/entities';

export type VaultMode = 'device' | 'passphrase';

export interface VaultStatus {
  readonly initialized: boolean;
  readonly mode: VaultMode;
  readonly unlocked: boolean;
  readonly secretCount: number;
  readonly autoLockMs: number;
}

interface VaultMeta {
  readonly version: number;
  readonly mode: VaultMode;
  readonly salt: string;
  readonly verifier: string;
  readonly iterations: number;
  readonly updatedAt: number;
}

const VAULT_FORMAT_VERSION = 1;
const VERIFIER_PLAINTEXT = 'adt-vault-verifier-v1';

/**
 * Local secret vault.
 *
 * Secrets are encrypted with AES-GCM. The data-encryption key is derived either
 * from a user passphrase (PBKDF2, 310k iterations) or - in `device` mode - from
 * a random device key kept in localStorage. Both paths go through the same
 * `KeyVault` interface, so strengthening the scheme later (WebAuthn, hardware
 * keys, Argon2 WASM) does not touch any caller.
 *
 * Guarantees:
 * - raw secrets never leave this module,
 * - raw secrets are never logged, never persisted as plaintext, never synced,
 * - wrong passphrase and locked vault are distinguishable, typed failures.
 */
export interface KeyVault {
  ready(): Promise<void>;
  status(): Promise<VaultStatus>;
  unlock(passphrase: string): Promise<boolean>;
  lock(): void;
  isUnlocked(): boolean;
  setPassphrase(passphrase: string): Promise<void>;
  removePassphrase(): Promise<void>;
  storeSecret(id: string, secret: string): Promise<void>;
  retrieveSecret(id: string): Promise<string | null>;
  deleteSecret(id: string): Promise<void>;
  listSecretIds(): Promise<string[]>;
  touch(): void;
  setAutoLock(ms: number): void;
  subscribe(listener: (status: VaultStatus) => void): () => void;
}

class LocalKeyVault implements KeyVault {
  private meta: VaultMeta | null = null;
  private key: CryptoKey | null = null;
  private readyPromise: Promise<void> | null = null;
  private autoLockMs: number = VAULT_DEFAULTS.autoLockMs;
  private autoLockTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(status: VaultStatus) => void>();

  ready(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().catch((error: unknown) => {
        this.readyPromise = null;
        throw toAppError(error, 'vault_failed');
      });
    }
    return this.readyPromise;
  }

  private async initialize(): Promise<void> {
    this.meta = this.readMeta();
    if (this.meta && this.meta.mode === 'device') {
      // Device mode can always re-derive its key without user interaction.
      this.key = await this.deriveKey(this.deviceSecret(), this.meta.salt, this.meta.iterations);
      this.scheduleAutoLock();
    }
    if (this.meta) this.notify();
  }

  async status(): Promise<VaultStatus> {
    await this.ready();
    const secretCount = (await secretsRepo.count().catch(() => 0)) ?? 0;
    return {
      initialized: this.meta !== null,
      mode: this.meta?.mode ?? 'device',
      unlocked: this.key !== null,
      secretCount,
      autoLockMs: this.autoLockMs,
    };
  }

  isUnlocked(): boolean {
    return this.key !== null;
  }

  async unlock(passphrase: string): Promise<boolean> {
    await this.ready();
    const meta = this.meta;
    if (!meta) throw new AppError('Vault is not initialized', { code: 'vault_failed' });
    if (meta.mode !== 'passphrase') {
      this.key = await this.deriveKey(this.deviceSecret(), meta.salt, meta.iterations);
      this.scheduleAutoLock();
      this.notify();
      return true;
    }
    if (passphrase.length < 8) {
      throw new AppError('Passphrase must be at least 8 characters', { code: 'vault_wrong_passphrase' });
    }
    try {
      const candidate = await this.deriveKey(passphrase, meta.salt, meta.iterations);
      const plain = await this.decrypt(candidate, meta.verifier);
      if (plain !== VERIFIER_PLAINTEXT) {
        return false;
      }
      this.key = candidate;
      this.scheduleAutoLock();
      this.notify();
      return true;
    } catch {
      return false;
    }
  }

  lock(): void {
    this.key = null;
    if (this.autoLockTimer) {
      clearTimeout(this.autoLockTimer);
      this.autoLockTimer = null;
    }
    this.notify();
  }

  async setPassphrase(passphrase: string): Promise<void> {
    await this.ready();
    if (passphrase.length < 8) {
      throw new AppError('Passphrase must be at least 8 characters', { code: 'validation' });
    }
    const oldKey = this.key;
    const oldMeta = this.meta;
    const salt = randomBase64(16);
    const iterations = VAULT_DEFAULTS.kdfIterations;
    const nextKey = await this.deriveKey(passphrase, salt, iterations);
    const verifier = await this.encrypt(nextKey, VERIFIER_PLAINTEXT);

    // Re-encrypt every existing secret under the new key before committing.
    const records = await secretsRepo.getAll();
    const reencrypted: SecretRecord[] = [];
    for (const record of records) {
      const plain = await this.decryptWith(oldKey, oldMeta, record);
      if (plain === null) continue;
      reencrypted.push({
        ...record,
        ...(await this.encryptRecord(nextKey, plain)),
        version: VAULT_FORMAT_VERSION,
        updatedAt: Date.now(),
      });
    }
    if (reencrypted.length > 0) await secretsRepo.putMany(reencrypted);

    const meta: VaultMeta = {
      version: VAULT_FORMAT_VERSION,
      mode: 'passphrase',
      salt,
      verifier,
      iterations,
      updatedAt: Date.now(),
    };
    this.writeMeta(meta);
    this.meta = meta;
    this.key = nextKey;
    this.scheduleAutoLock();
    this.notify();
    logger.info('Vault upgraded to passphrase mode');
  }

  async removePassphrase(): Promise<void> {
    await this.ready();
    if (!this.key) throw new AppError('Vault is locked', { code: 'vault_locked' });
    const oldMeta = this.meta;
    const salt = randomBase64(16);
    const iterations = VAULT_DEFAULTS.kdfIterations;
    const nextKey = await this.deriveKey(this.deviceSecret(), salt, iterations);
    const verifier = await this.encrypt(nextKey, VERIFIER_PLAINTEXT);

    const records = await secretsRepo.getAll();
    const reencrypted: SecretRecord[] = [];
    for (const record of records) {
      const plain = await this.decryptWith(this.key, oldMeta, record);
      if (plain === null) continue;
      reencrypted.push({
        ...record,
        ...(await this.encryptRecord(nextKey, plain)),
        version: VAULT_FORMAT_VERSION,
        updatedAt: Date.now(),
      });
    }
    if (reencrypted.length > 0) await secretsRepo.putMany(reencrypted);

    const meta: VaultMeta = {
      version: VAULT_FORMAT_VERSION,
      mode: 'device',
      salt,
      verifier,
      iterations,
      updatedAt: Date.now(),
    };
    this.writeMeta(meta);
    this.meta = meta;
    this.key = nextKey;
    this.scheduleAutoLock();
    this.notify();
    logger.info('Vault downgraded to device mode');
  }

  async storeSecret(id: string, secret: string): Promise<void> {
    const key = await this.requireKey();
    const now = Date.now();
    const existing = await secretsRepo.get(id);
    const record: SecretRecord = {
      id,
      ...(await this.encryptRecord(key, secret)),
      version: VAULT_FORMAT_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await secretsRepo.put(record);
    this.scheduleAutoLock();
    this.notify();
  }

  async retrieveSecret(id: string): Promise<string | null> {
    const key = await this.requireKey();
    const record = await secretsRepo.get(id);
    if (!record) return null;
    const plain = await this.decryptWith(key, this.meta, record);
    this.scheduleAutoLock();
    return plain;
  }

  async deleteSecret(id: string): Promise<void> {
    await secretsRepo.delete(id);
    this.notify();
  }

  async listSecretIds(): Promise<string[]> {
    const records = await secretsRepo.getAll().catch(() => [] as SecretRecord[]);
    return records.map((record) => record.id);
  }

  touch(): void {
    if (this.key) this.scheduleAutoLock();
  }

  setAutoLock(ms: number): void {
    this.autoLockMs = Math.max(30_000, ms);
    this.scheduleAutoLock();
  }

  subscribe(listener: (status: VaultStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- internals ---------------------------------------------------------

  private async requireKey(): Promise<CryptoKey> {
    await this.ready();
    if (!this.key) {
      throw new AppError('Vault is locked - unlock it to access stored keys', {
        code: 'vault_locked',
        retryable: true,
      });
    }
    return this.key;
  }

  private async encryptRecord(key: CryptoKey, plain: string): Promise<{ ciphertext: string; iv: string }> {
    const iv = randomBase64(12);
    const bytes = new TextEncoder().encode(plain);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, bytes);
    return { ciphertext: toBase64(new Uint8Array(encrypted)), iv };
  }

  private async decryptWith(
    key: CryptoKey | null,
    meta: VaultMeta | null,
    record: SecretRecord,
  ): Promise<string | null> {
    if (!key) throw new AppError('Vault is locked', { code: 'vault_locked', retryable: true });
    try {
      const plain = await this.decryptWithKey(key, record.ciphertext, record.iv);
      return plain;
    } catch (error) {
      if (meta === null) logger.warn('Vault record could not be decrypted');
      throw toAppError(error, 'vault_failed');
    }
  }

  private async encrypt(key: CryptoKey, plain: string): Promise<string> {
    const iv = randomBase64(12);
    const bytes = new TextEncoder().encode(plain);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, bytes);
    return `${iv}:${toBase64(new Uint8Array(encrypted))}`;
  }

  private async decrypt(key: CryptoKey, packed: string): Promise<string> {
    const [iv, data] = packed.split(':');
    if (!iv || !data) throw new Error('Malformed verifier');
    const bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) },
      key,
      fromBase64(data),
    );
    return new TextDecoder().decode(bytes);
  }

  private async decryptWithKey(key: CryptoKey, ciphertext: string, iv: string): Promise<string> {
    const bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv) },
      key,
      fromBase64(ciphertext),
    );
    return new TextDecoder().decode(bytes);
  }

  private async deriveKey(secret: string, saltBase64: string, iterations: number): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: fromBase64(saltBase64), iterations, hash: VAULT_DEFAULTS.hash },
      baseKey,
      { name: VAULT_DEFAULTS.algorithm, length: VAULT_DEFAULTS.keyLengthBits },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  private deviceSecret(): string {
    try {
      const existing = localStorage.getItem(`${LOCAL_STORAGE_KEYS.vaultMeta}.device`);
      if (existing) return existing;
      const generated = randomBase64(32);
      localStorage.setItem(`${LOCAL_STORAGE_KEYS.vaultMeta}.device`, generated);
      return generated;
    } catch {
      // Storage unavailable: derive from a per-session random secret.
      return randomBase64(32);
    }
  }

  private readMeta(): VaultMeta | null {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEYS.vaultMeta);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as VaultMeta;
      if (!parsed || typeof parsed.salt !== 'string' || typeof parsed.verifier !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: VaultMeta): void {
    localStorage.setItem(LOCAL_STORAGE_KEYS.vaultMeta, JSON.stringify(meta));
  }

  private scheduleAutoLock(): void {
    if (this.autoLockTimer) clearTimeout(this.autoLockTimer);
    if (!this.key) return;
    this.autoLockTimer = setTimeout(() => {
      this.key = null;
      this.notify();
      logger.info('Vault auto-locked');
    }, this.autoLockMs);
  }

  private notify(): void {
    const base: Omit<VaultStatus, 'secretCount'> = {
      initialized: this.meta !== null,
      mode: this.meta?.mode ?? 'device',
      unlocked: this.key !== null,
      autoLockMs: this.autoLockMs,
    };
    void secretsRepo
      .count()
      .catch(() => 0)
      .then((count) => {
        const status: VaultStatus = { ...base, secretCount: count };
        for (const listener of [...this.listeners]) {
          try {
            listener(status);
          } catch (error) {
            logger.errorWith(error, 'Vault listener failed');
          }
        }
        appEvents.emit('vault:changed', {});
      });
  }
}

function randomBase64(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64(buffer);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  // A fresh ArrayBuffer (not a pooled one) keeps the type assignable to
  // BufferSource under the ES2024 typed-array generics.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const keyVault: KeyVault = new LocalKeyVault();
