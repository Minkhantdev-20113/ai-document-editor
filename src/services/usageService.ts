import { appEvents } from '../core/events/eventBus';
import { logger } from '../core/logging/logger';
import { usageRepo } from '../db/repositories';
import type { UsageSnapshot } from '../db/entities';
import type { ProviderId } from '../providers/types';
import { getProviderDescriptor } from '../providers/registry';

export interface RecordUsageInput {
  readonly providerId: ProviderId;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  readonly costUsd?: number | null;
  /**
   * Where the token figures came from. `provider_reported` = counted from the
   * provider's own response usage; `locally_estimated` = computed in-app.
   * Cost is always estimated regardless of this flag.
   */
  readonly basis?: 'provider_reported' | 'locally_estimated';
}

export interface UsageAggregate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function windowStartFor(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function snapshotId(providerId: ProviderId, windowStart: number): string {
  return `use_${providerId}_${windowStart}`;
}

/**
 * Usage accounting.
 *
 * Snapshots are stored per provider + day. Cost figures are estimates derived
 * from the published model pricing in the catalog - nothing here bills anyone.
 */
class UsageService {
  async list(): Promise<UsageSnapshot[]> {
    const snapshots = await usageRepo.getAll();
    return snapshots.sort((a, b) => b.windowStart - a.windowStart);
  }

  async record(input: RecordUsageInput): Promise<void> {
    const windowStart = windowStartFor(Date.now());
    const id = snapshotId(input.providerId, windowStart);
    const existing = await usageRepo.get(id);
    const timestamp = Date.now();
    const cost = input.costUsd ?? estimateCost(input.providerId, input.model, input) ?? 0;
    const basis = input.basis ?? 'locally_estimated';

    const snapshot: UsageSnapshot = existing
      ? {
          ...existing,
          requests: existing.requests + 1,
          inputTokens: existing.inputTokens + input.inputTokens,
          outputTokens: existing.outputTokens + input.outputTokens,
          cachedTokens: existing.cachedTokens + (input.cachedTokens ?? 0),
          estimatedCostUsd: (existing.estimatedCostUsd ?? 0) + cost,
          // Mixed contributions can no longer claim to be provider-reported.
          basis:
            (existing.basis ?? 'locally_estimated') === basis && basis === 'provider_reported'
              ? 'provider_reported'
              : 'locally_estimated',
          updatedAt: timestamp,
        }
      : {
          id,
          providerId: input.providerId,
          model: input.model,
          windowStart,
          windowEnd: windowStart + DAY_MS,
          requests: 1,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          cachedTokens: input.cachedTokens ?? 0,
          estimatedCostUsd: cost,
          source: 'engine',
          basis,
          updatedAt: timestamp,
        };

    await usageRepo.put(snapshot);
    appEvents.emit('usage:changed', {});
  }

  /**
   * Provider-scoped totals for `AIProvider.getUsage()`.
   *
   * `providerReported` is true only when every contributing snapshot came from
   * a provider response; otherwise the caller must label the figures estimated.
   * Actual quota balances (RPM/TPD remaining) are not queryable through the
   * public APIs we use - the pool's cooldown state is the local stand-in.
   */
  async totalsFor(providerId: ProviderId): Promise<{
    providerReported: boolean;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    asOf: number;
  }> {
    const snapshots = (await this.list()).filter((snapshot) => snapshot.providerId === providerId);
    const providerReported =
      snapshots.length > 0 && snapshots.every((snapshot) => snapshot.basis === 'provider_reported');
    return {
      providerReported,
      requests: snapshots.reduce((sum, snapshot) => sum + snapshot.requests, 0),
      inputTokens: snapshots.reduce((sum, snapshot) => sum + snapshot.inputTokens, 0),
      outputTokens: snapshots.reduce((sum, snapshot) => sum + snapshot.outputTokens, 0),
      estimatedCostUsd: snapshots.reduce((sum, snapshot) => sum + (snapshot.estimatedCostUsd ?? 0), 0),
      asOf: Date.now(),
    };
  }

  async aggregateByProvider(): Promise<Record<string, UsageAggregate>> {
    const snapshots = await this.list();
    const out: Record<string, UsageAggregate> = {};
    for (const snapshot of snapshots) {
      const bucket = (out[snapshot.providerId] ??= {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        estimatedCostUsd: 0,
      });
      bucket.requests += snapshot.requests;
      bucket.inputTokens += snapshot.inputTokens;
      bucket.outputTokens += snapshot.outputTokens;
      bucket.cachedTokens += snapshot.cachedTokens;
      bucket.estimatedCostUsd += snapshot.estimatedCostUsd ?? 0;
    }
    return out;
  }

  async totals(): Promise<UsageAggregate> {
    const aggregates = await this.aggregateByProvider();
    return Object.values(aggregates).reduce<UsageAggregate>(
      (total, item) => ({
        requests: total.requests + item.requests,
        inputTokens: total.inputTokens + item.inputTokens,
        outputTokens: total.outputTokens + item.outputTokens,
        cachedTokens: total.cachedTokens + item.cachedTokens,
        estimatedCostUsd: total.estimatedCostUsd + item.estimatedCostUsd,
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, estimatedCostUsd: 0 },
    );
  }

  async clear(): Promise<void> {
    await usageRepo.clear();
    appEvents.emit('usage:changed', {});
  }
}

function estimateCost(providerId: ProviderId, model: string | null, input: RecordUsageInput): number | null {
  try {
    const descriptor = getProviderDescriptor(providerId);
    const modelInfo = model ? descriptor.models.find((entry) => entry.id === model) : undefined;
    if (!modelInfo?.inputPricePerMillion || !modelInfo.outputPricePerMillion) return null;
    const cost =
      (input.inputTokens / 1_000_000) * modelInfo.inputPricePerMillion +
      (input.outputTokens / 1_000_000) * modelInfo.outputPricePerMillion;
    return Math.round(cost * 10_000) / 10_000;
  } catch {
    logger.debug('Cost estimate unavailable', { providerId });
    return null;
  }
}

export const usageService = new UsageService();
