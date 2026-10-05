import { describe, expect, it } from 'vitest';
import {
  JOB_STATES,
  JOB_TYPES,
  activeStateFor,
  canTransition,
  isActive,
  isTerminal,
  needsRecovery,
  nextStates,
} from './jobStates';

describe('job state machine', () => {
  it('exposes exactly the nine phase-1 states', () => {
    expect([...JOB_STATES]).toEqual([
      'queued',
      'analyzing',
      'translating',
      'paused',
      'retrying',
      'exporting',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('keeps terminal states terminal', () => {
    expect(nextStates('completed')).toHaveLength(0);
    for (const state of JOB_STATES) {
      expect(canTransition('completed', state)).toBe(state === 'completed');
    }
    expect(canTransition('cancelled', 'cancelled')).toBe(true);
    expect(canTransition('cancelled', 'translating')).toBe(false);
  });

  it('rejects illegal jumps used by UI actions', () => {
    expect(canTransition('completed', 'translating')).toBe(false);
    expect(canTransition('failed', 'completed')).toBe(false);
    expect(canTransition('cancelled', 'completed')).toBe(false);
    expect(canTransition('paused', 'translating')).toBe(false);
    expect(canTransition('queued', 'completed')).toBe(false);
  });

  it('allows the normal lifecycle paths', () => {
    expect(canTransition('queued', 'analyzing')).toBe(true);
    expect(canTransition('analyzing', 'translating')).toBe(true);
    expect(canTransition('analyzing', 'completed')).toBe(true);
    expect(canTransition('analyzing', 'exporting')).toBe(true);
    expect(canTransition('translating', 'exporting')).toBe(true);
    expect(canTransition('translating', 'completed')).toBe(true);
    expect(canTransition('exporting', 'completed')).toBe(true);
    expect(canTransition('translating', 'paused')).toBe(true);
    expect(canTransition('paused', 'queued')).toBe(true);
    expect(canTransition('failed', 'retrying')).toBe(true);
    expect(canTransition('retrying', 'queued')).toBe(true);
  });

  it('classifies states for the UI and for refresh recovery', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('failed')).toBe(false);
    expect(isActive('analyzing')).toBe(true);
    expect(isActive('exporting')).toBe(true);
    expect(isActive('queued')).toBe(false);
    expect(needsRecovery('translating')).toBe(true);
    expect(needsRecovery('queued')).toBe(false);
    expect(needsRecovery('paused')).toBe(false);
  });

  it('maps every job type to a valid active state', () => {
    for (const type of JOB_TYPES) {
      const target = activeStateFor(type);
      expect(canTransition('queued', target)).toBe(true);
      expect(isActive(target)).toBe(true);
    }
    expect(activeStateFor('translate_document')).toBe('translating');
    expect(activeStateFor('export_document')).toBe('exporting');
  });
});
