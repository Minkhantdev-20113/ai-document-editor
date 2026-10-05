import { describe, expect, it } from 'vitest';
import { AppError } from '../core/errors/appError';
import {
  GLOSSARY_LIMITS,
  isDuplicateTerm,
  normalizeTerm,
  toGlossaryRule,
  validateGlossaryInput,
} from './glossary';

const BASE = {
  sourceTerm: 'the Submit button',
  preferredTranslation: 'တင်သည့်ခလုတ်',
};

describe('glossary domain', () => {
  it('normalizes terms for matching: trim, lowercase, collapse spaces', () => {
    expect(normalizeTerm('  Submit   BUTTON ')).toBe('submit button');
    expect(normalizeTerm('မြန်မာ')).toBe('မြန်မာ');
    expect(normalizeTerm('')).toBe('');
  });

  it('accepts a well-formed input and trims it', () => {
    const fields = validateGlossaryInput({
      ...BASE,
      sourceTerm: '  the Submit button  ',
      forbiddenTranslation: '  တင်ရန်  ',
      notes: '  UI control  ',
    });
    expect(fields).toEqual({
      sourceTerm: 'the Submit button',
      preferredTranslation: 'တင်သည့်ခလုတ်',
      forbiddenTranslation: 'တင်ရန်',
      notes: 'UI control',
    });
  });

  it('normalizes whitespace-only optional fields to null', () => {
    const fields = validateGlossaryInput({
      ...BASE,
      forbiddenTranslation: '   ',
      notes: '',
    });
    expect(fields.forbiddenTranslation).toBeNull();
    expect(fields.notes).toBeNull();
  });

  it('rejects an empty or whitespace-only term with a typed validation error', () => {
    for (const sourceTerm of ['', '   ']) {
      try {
        validateGlossaryInput({ ...BASE, sourceTerm });
        expect.unreachable('expected a validation error');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('validation');
        expect((error as AppError).retryable).toBe(false);
      }
    }
  });

  it('rejects an empty preferred translation (forbidden alone is not a rule)', () => {
    expect(() => validateGlossaryInput({ ...BASE, preferredTranslation: ' ' })).toThrow(
      /preferred translation/i,
    );
  });

  it('enforces field length limits', () => {
    expect(() =>
      validateGlossaryInput({ ...BASE, sourceTerm: 'x'.repeat(GLOSSARY_LIMITS.maxTermLength + 1) }),
    ).toThrow(/limited to/);
    expect(() =>
      validateGlossaryInput({
        ...BASE,
        preferredTranslation: 'x'.repeat(GLOSSARY_LIMITS.maxTranslationLength + 1),
      }),
    ).toThrow(/limited to/);
    expect(() =>
      validateGlossaryInput({
        ...BASE,
        notes: 'x'.repeat(GLOSSARY_LIMITS.maxNotesLength + 1),
      }),
    ).toThrow(/limited to/);
  });

  it('detects duplicates case-insensitively and honours the excluded id', () => {
    const entries = [
      { id: 'a', sourceTerm: 'Submit Button', preferredTranslation: 'X', forbiddenTranslation: null, notes: null },
      { id: 'b', sourceTerm: 'delete', preferredTranslation: 'Y', forbiddenTranslation: null, notes: null },
    ];
    expect(isDuplicateTerm(entries, '  submit   button ')).toBe(true);
    expect(isDuplicateTerm(entries, 'Submit Button', 'a')).toBe(false);
    expect(isDuplicateTerm(entries, 'Submit Button', 'b')).toBe(true);
    expect(isDuplicateTerm(entries, 'cancel')).toBe(false);
    // An empty needle never matches anything (no accidental duplicates).
    expect(isDuplicateTerm(entries, '  ')).toBe(false);
  });

  it('projects an entry into a rule, dropping empty optional fields', () => {
    const rule = toGlossaryRule({
      sourceTerm: 'dashboard',
      preferredTranslation: 'ဒက်ရှ်ဘုတ်',
      forbiddenTranslation: null,
      notes: null,
    });
    expect(rule).toEqual({ source: 'dashboard', preferred: 'ဒက်ရှ်ဘုတ်' });

    const full = toGlossaryRule({
      sourceTerm: 'dashboard',
      preferredTranslation: 'ဒက်ရှ်ဘုတ်',
      forbiddenTranslation: 'ပြခန်း',
      notes: 'keep loanword',
    });
    expect(full).toEqual({
      source: 'dashboard',
      preferred: 'ဒက်ရှ်ဘုတ်',
      forbidden: 'ပြခန်း',
      notes: 'keep loanword',
    });
  });
});
