import { describe, expect, it } from 'vitest';
import { planBatches, type BatchingPolicy } from './batching';

function units(count: number, chars = 400): { id: string; text: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `u${index + 1}`,
    text: `source text ${index + 1} `.repeat(Math.ceil(chars / 20)),
  }));
}

const POLICY: BatchingPolicy = {
  contextWindow: 16_384,
  maxOutputTokens: 4_096,
  sourceLanguage: 'en',
  targetLanguage: 'my',
  documentType: 'pdf',
};

describe('planBatches', () => {
  it('keeps every unit exactly once, in order, never split', () => {
    const input = units(60, 600);
    const plan = planBatches(input, POLICY);
    const rebuilt = plan.batches.flatMap((batch) => batch.units.map((unit) => unit.id));
    expect(rebuilt).toEqual(input.map((unit) => unit.id));
    expect(plan.oversizedUnitIds).toHaveLength(0);
  });

  it('produces multiple controlled batches instead of one huge request', () => {
    const plan = planBatches(units(120, 1_200), POLICY);
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches.length).toBeGreaterThan(10); // batches stay small enough to focus
  });

  it('keeps prompt plus estimated output inside the model limits', () => {
    const plan = planBatches(units(80, 900), POLICY);
    for (const batch of plan.batches) {
      expect(batch.promptTokens + batch.estimatedOutputTokens).toBeLessThanOrEqual(POLICY.contextWindow);
      expect(batch.promptTokens).toBeGreaterThan(0);
      expect(batch.estimatedOutputTokens).toBeGreaterThan(0);
    }
  });

  it('respects maxUnitsPerBatch', () => {
    const plan = planBatches(units(30, 60), { ...POLICY, maxUnitsPerBatch: 5 });
    for (const batch of plan.batches) {
      expect(batch.units.length).toBeLessThanOrEqual(5);
    }
    expect(plan.batches.length).toBeGreaterThanOrEqual(6);
  });

  it('flags a unit that cannot fit in any single request but still attempts it alone', () => {
    const [unitA, unitB] = units(2, 50);
    if (!unitA || !unitB) throw new Error('fixture error');
    const huge = { id: 'huge', text: 'x'.repeat(300_000) };
    const plan = planBatches([unitA, huge, unitB], POLICY);
    expect(plan.oversizedUnitIds).toEqual(['huge']);
    const hugeBatch = plan.batches.find((batch) => batch.units.length === 1 && batch.units[0]?.id === 'huge');
    expect(hugeBatch).toBeDefined();
  });

  it('estimates Burmese output expansion conservatively', () => {
    const plan = planBatches(units(3, 500), POLICY);
    const batch = plan.batches[0];
    expect(batch).toBeDefined();
    const chars = batch?.units.reduce((sum, unit) => sum + unit.text.length, 0) ?? 0;
    expect(batch?.estimatedOutputTokens).toBeGreaterThanOrEqual(chars * 1.6);
  });

  it('splits into more, smaller batches for precise quality than for draft', () => {
    const input = units(40, 800);
    const precise = planBatches(input, { ...POLICY, quality: 'precise' });
    const draft = planBatches(input, { ...POLICY, quality: 'draft' });
    expect(precise.batches.length).toBeGreaterThan(draft.batches.length);
  });

  it('uses smaller batches for structured/noisy document types', () => {
    const input = units(40, 800);
    const csv = planBatches(input, { ...POLICY, documentType: 'csv' });
    const text = planBatches(input, { ...POLICY, documentType: 'text' });
    expect(csv.batches.length).toBeGreaterThan(text.batches.length);
  });

  it('plans larger batches when the provider RPM is very low', () => {
    const input = units(40, 800);
    const lowRpm = planBatches(input, { ...POLICY, rpm: 3 });
    const normalRpm = planBatches(input, { ...POLICY, rpm: 60 });
    expect(lowRpm.batches.length).toBeLessThanOrEqual(normalRpm.batches.length);
  });
});
