import { describe, expect, it } from 'vitest';
import type { GlossaryRule } from './glossary';
import { duplicateWarnings, unitWarnings, type UnitCheckContext } from './validation';

const EN_MY: UnitCheckContext = { sourceLanguage: 'en', targetLanguage: 'my' };

function done(sourceText: string, translatedText: string | null) {
  return { sourceText, translatedText, status: 'translated' as const };
}

describe('unitWarnings - completion checks', () => {
  it('flags a completed unit with no text at all', () => {
    expect(unitWarnings(done('Hello world, this is a sentence.', null), EN_MY)).toEqual([
      { code: 'missing_text' },
    ]);
  });

  it('flags a completed unit whose text is blank', () => {
    expect(unitWarnings(done('Hello world, this is a sentence.', '   '), EN_MY)).toEqual([
      { code: 'unexpected_empty' },
    ]);
  });

  it('treats unfinished units as unfinished, not as validation failures', () => {
    const context = EN_MY;
    expect(
      unitWarnings({ sourceText: 'Hello world.', translatedText: null, status: 'pending' }, context),
    ).toEqual([]);
    expect(
      unitWarnings({ sourceText: 'Hello world.', translatedText: null, status: 'failed' }, context),
    ).toEqual([]);
    // Done status but no stored text is still broken.
    expect(
      unitWarnings({ sourceText: 'Hello world.', translatedText: null, status: 'reviewed' }, context),
    ).toEqual([{ code: 'missing_text' }]);
  });
});

describe('unitWarnings - untranslated segments', () => {
  it('flags identical prose across different languages', () => {
    const warnings = unitWarnings(
      done('The quick brown fox jumps over the lazy dog again.', 'The quick brown fox jumps over the lazy dog again.'),
      EN_MY,
    );
    expect(warnings.map((warning) => warning.code)).toContain('untranslated');
  });

  it('accepts identical text when source and target are the same language', () => {
    const context = { sourceLanguage: 'en', targetLanguage: 'en' };
    expect(
      unitWarnings(done('Leave this field exactly as it is.', 'Leave this field exactly as it is.'),
        context,
      ).length,
    ).toBe(0);
  });

  it('accepts short fragments that legitimately stay identical', () => {
    expect(unitWarnings(done('OK', 'OK'), EN_MY)).toEqual([]);
  });
});

describe('unitWarnings - preservation checks', () => {
  it('produces no warnings when numbers, units, URLs and code are preserved', () => {
    // Our rules require ASCII numbers/units/code to survive verbatim.
    const warnings = unitWarnings(
      done(
        'Save 1,000 files within 3.5 hours at 10 km over https://example.com/docs using `npm run build` and user_id.',
        '1,000 ဖိုင်ကို 3.5 နာရီအတွင်း https://example.com/docs တွင် 10 km အကွာ `npm run build` နှင့် user_id ဖြင့် သိမ်းပါ။',
      ),
      EN_MY,
    );
    expect(warnings).toEqual([]);
  });

  it('flags a missing number with the token in the detail', () => {
    const warnings = unitWarnings(
      done('Copy 3 files to the folder.', 'ဖိုင်များကို စာအိတ်သို့ ကူးပါ။'),
      EN_MY,
    );
    expect(warnings).toContainEqual({ code: 'numbers_changed', detail: '3' });
  });

  it('flags a missing measurement unit with the expression in the detail', () => {
    const warnings = unitWarnings(
      done('Drive 10 km to the office.', 'ရုံးသို့ သွားပါ။'),
      EN_MY,
    );
    expect(warnings).toContainEqual({ code: 'units_changed', detail: '10 km' });
  });

  it('flags a dropped URL', () => {
    const warnings = unitWarnings(
      done('Read more at https://example.com/docs.', 'နောက်ထပ် ဖတ်ပါ။'),
      EN_MY,
    );
    expect(warnings.map((warning) => warning.code)).toContain('urls_changed');
  });

  it('flags dropped code spans and identifiers', () => {
    const warnings = unitWarnings(
      done('Run `git status` and edit config_file_name in buildPath.', 'အမိန့်ကို run ပါ။'),
      EN_MY,
    );
    const codes = warnings.filter((warning) => warning.code === 'code_changed');
    expect(codes).toHaveLength(1);
    const detail = codes[0]?.detail?.split(', ').join(' ') ?? '';
    expect(detail).toContain('`git status`');
    expect(detail).toContain('config_file_name');
    expect(detail).toContain('buildPath');
  });

  it('flags structure mismatches with a readable detail', () => {
    const warnings = unitWarnings(
      done('# Title\n- one\n- two', '# ခေါင်းစဉ်\n- တစ်'),
      EN_MY,
    );
    expect(warnings).toContainEqual({ code: 'structure_mismatch', detail: 'lists 2 → 1' });
  });

  it('keeps markdown structure parity clean', () => {
    const warnings = unitWarnings(
      done('# ခေါင်းစဉ်\n- တစ်\n- နှစ်\n[link](https://example.com)', '# ခေါင်းစဉ်\n- တစ်\n- နှစ်\n[လင့်ခ်](https://example.com)'),
      { sourceLanguage: 'my', targetLanguage: 'en' },
    );
    expect(warnings).toEqual([]);
  });
});

describe('unitWarnings - glossary violations', () => {
  const glossary: GlossaryRule[] = [
    {
      source: 'the Submit button',
      preferred: 'တင်သည့်ခလုတ်',
      forbidden: 'တင်ရန်ခလုတ်',
      notes: 'UI control',
    },
  ];
  const context: UnitCheckContext = { ...EN_MY, glossary };

  it('flags forbidden wording in the translation', () => {
    const warnings = unitWarnings(
      done('Click the Submit button.', 'တင်ရန်ခလုတ်ကို နှိပ်ပါ။'),
      context,
    );
    expect(warnings).toEqual([{ code: 'glossary_violation', detail: 'forbidden: တင်ရန်ခလုတ်' }]);
  });

  it('flags a missing preferred rendering when the source term is present', () => {
    const warnings = unitWarnings(
      done('Press the Submit button now.', 'အခု ခလုတ်ကို နှိပ်ပါ။'),
      context,
    );
    expect(warnings).toEqual([{ code: 'glossary_violation', detail: 'missing: တင်သည့်ခလုတ်' }]);
  });

  it('accepts the preferred rendering and accepts keeping the source term', () => {
    expect(unitWarnings(done('Click the Submit button.', 'တင်သည့်ခလုတ်ကို နှိပ်ပါ။'), context)).toEqual([]);
    expect(unitWarnings(done('Click the Submit button.', 'the Submit button ကို နှိပ်ပါ။'), context)).toEqual([]);
  });

  it('requires nothing when the source does not contain the term', () => {
    expect(unitWarnings(done('Save the document.', 'စာရွက်ကို သိမ်းပါ။'), context)).toEqual([]);
  });

  it('stays silent with no glossary', () => {
    expect(unitWarnings(done('Click the Submit button.', 'နှိပ်ပါ။'), EN_MY)).toEqual([]);
  });
});

describe('duplicateWarnings (document level)', () => {
  const base = { sourceLanguage: 'en', targetLanguage: 'my', status: 'translated' as const };

  it('flags identical translations of DIFFERENT sources', () => {
    const flagged = duplicateWarnings([
      { id: 'u1', sourceText: 'Save the document.', translatedText: 'သိမ်းပါ', ...base },
      { id: 'u2', sourceText: 'Close the window.', translatedText: 'သိမ်းပါ', ...base },
      { id: 'u3', sourceText: 'Something else.', translatedText: 'မတူညီ', ...base },
    ]);
    expect([...flagged.keys()].sort()).toEqual(['u1', 'u2']);
    expect(flagged.get('u1')).toEqual({ code: 'duplicated_text' });
  });

  it('accepts identical translations of identical sources', () => {
    const flagged = duplicateWarnings([
      { id: 'u1', sourceText: 'Footer text.', translatedText: 'Footer စာသား', ...base },
      { id: 'u2', sourceText: 'Footer text.', translatedText: 'Footer စာသား', ...base },
    ]);
    expect(flagged.size).toBe(0);
  });

  it('ignores untranslated, blank and unfinished units', () => {
    const flagged = duplicateWarnings([
      { id: 'u1', sourceText: 'Same text here.', translatedText: 'တူညီ', status: 'pending' },
      { id: 'u2', sourceText: 'Other text here.', translatedText: 'တူညီ', status: 'pending' },
      { id: 'u3', sourceText: 'Same text here.', translatedText: 'တူညီ', status: 'translated' },
      { id: 'u4', sourceText: 'Other text here.', translatedText: null, status: 'failed' },
    ]);
    expect(flagged.size).toBe(0);
  });
});
