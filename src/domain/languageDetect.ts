import { LANGUAGE_CONFIRM_THRESHOLD, type LanguageDetection } from './analysis/ir';

/**
 * Source-language detection.
 *
 * Deliberately multi-heuristic: Unicode script shares decide between scripts,
 * stopword frequency separates Latin-script languages, character cues refine
 * ambiguous scripts (Persian vs Arabic, Simplified vs Traditional Chinese),
 * and language particles strengthen Burmese. Confidence is the evidence share
 * of the winner, so mixed or thin samples fall below the confirmation
 * threshold and the UI asks the user instead of guessing.
 */

const SAMPLE_LIMIT = 6_000;
const MIN_LETTERS = 8;

type ScriptName =
  | 'myanmar'
  | 'thai'
  | 'arabic'
  | 'persian'
  | 'devanagari'
  | 'han'
  | 'kana'
  | 'hangul'
  | 'cyrillic'
  | 'latin'
  | 'other';

const PERSIAN_LETTERS = new Set([...'پچژگکی']);
const SIMPLIFIED_ONLY = new Set([...'让说这来对时会过还没后发经头实']);
const TRADITIONAL_ONLY = new Set([...'讓說這來對時會過還沒後發經頭實']);

const STOPWORDS: Readonly<Record<string, readonly string[]>> = {
  en: ['the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'not', 'you', 'but', 'all', 'any', 'can', 'her', 'his', 'they'],
  fr: ['le', 'la', 'les', 'des', 'une', 'est', 'dans', 'pour', 'que', 'qui', 'avec', 'sur', 'pas', 'plus', 'leur', 'aussi', 'comme', 'fait'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'von', 'mit', 'für', 'auch', 'werden', 'sich', 'wird', 'nach', 'beim', 'über'],
  es: ['el', 'los', 'las', 'una', 'por', 'con', 'para', 'está', 'están', 'como', 'más', 'pero', 'este', 'esta', 'fue', 'han', 'del', 'que'],
  pt: ['os', 'uma', 'não', 'por', 'com', 'mais', 'dos', 'das', 'como', 'mas', 'foi', 'são', 'você', 'isso', 'ela', 'entre', 'após'],
  id: ['yang', 'dan', 'di', 'untuk', 'dengan', 'pada', 'ini', 'itu', 'dari', 'adalah', 'tidak', 'akan', 'juga', 'ada', 'atau', 'oleh'],
  vi: ['của', 'và', 'các', 'người', 'này', 'được', 'cho', 'có', 'để', 'không', 'với', 'những', 'một', 'đã', 'ở', 'khi'],
  ru: ['и', 'в', 'не', 'на', 'что', 'с', 'по', 'как', 'это', 'для', 'от', 'до', 'из', 'при', 'они', 'было', 'его'],
};

const BURMESE_PARTICLES = [
  'သည်',
  '၏',
  'ကို',
  'မှာ',
  'နှင့်',
  'ဖြင့်',
  'ဖြစ်',
  'ကြောင့်',
  'တွင်',
  'မှ',
  'အတွက်',
  'လည်း',
  'ပါ',
  'များ',
  'အား',
];

const LATIN_CANDIDATES = ['en', 'fr', 'de', 'es', 'pt', 'id', 'vi'] as const;

function classifyScript(char: string): ScriptName {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0x1000 && code <= 0x109f) return 'myanmar';
  if (code >= 0x0e00 && code <= 0x0e7f) return 'thai';
  if (PERSIAN_LETTERS.has(char)) return 'persian';
  if ((code >= 0x0600 && code <= 0x06ff) || (code >= 0x0750 && code <= 0x077f)) return 'arabic';
  if (code >= 0x0900 && code <= 0x097f) return 'devanagari';
  if (code >= 0x3040 && code <= 0x30ff) return 'kana';
  if (code >= 0x1100 && code <= 0x11ff || (code >= 0xac00 && code <= 0xd7af)) return 'hangul';
  if (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  ) {
    return 'han';
  }
  if (code >= 0x0400 && code <= 0x04ff) return 'cyrillic';
  if ((code >= 0x0041 && code <= 0x007a) || (code >= 0x00c0 && code <= 0x024f)) return 'latin';
  return 'other';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finalize(
  scores: Record<string, number>,
  sampleChars: number,
  confidence: number,
): LanguageDetection {
  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  const normalized: Record<string, number> = {};
  for (const [code, value] of Object.entries(scores)) {
    normalized[code] = total > 0 ? Number((value / total).toFixed(4)) : 0;
  }
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!winner || winner[1] <= 0) {
    return { code: 'unknown', confidence: 0, scores: {}, sampleChars };
  }
  return {
    code: winner[0],
    confidence: Number(clamp(confidence, 0, 1).toFixed(3)),
    scores: normalized,
    sampleChars,
  };
}

/**
 * Detects the language of `text` with a confidence score.
 * Never throws: undetectable input returns `unknown` with confidence 0.
 */
export function detectLanguage(text: string): LanguageDetection {
  const sample = text.slice(0, SAMPLE_LIMIT);
  if (sample.trim().length === 0) {
    return { code: 'unknown', confidence: 0, scores: {}, sampleChars: 0 };
  }

  // Pass 1: script histogram over letters.
  const scriptCounts: Record<string, number> = {};
  let letters = 0;
  let hanSimplified = 0;
  let hanTraditional = 0;
  for (const char of sample) {
    if (/\s/.test(char)) continue;
    const script = classifyScript(char);
    if (script === 'other') continue;
    letters += 1;
    scriptCounts[script] = (scriptCounts[script] ?? 0) + 1;
    if (script === 'han') {
      if (SIMPLIFIED_ONLY.has(char)) hanSimplified += 1;
      else if (TRADITIONAL_ONLY.has(char)) hanTraditional += 1;
    }
  }
  if (letters < MIN_LETTERS) {
    return { code: 'unknown', confidence: 0, scores: {}, sampleChars: sample.length };
  }

  const shareOf = (script: ScriptName): number => (scriptCounts[script] ?? 0) / letters;
  const entries = Object.entries(scriptCounts).sort((a, b) => b[1] - a[1]);
  const dominant = (entries[0]?.[0] ?? 'other') as ScriptName;
  const dominantShare = entries.length > 0 ? entries[0]![1] / letters : 0;
  const sampleFactor = Math.min(1, letters / 40);

  const scores: Record<string, number> = {};

  const scriptLanguage = (script: ScriptName): string | null => {
    switch (script) {
      case 'myanmar':
        return 'my';
      case 'thai':
        return 'th';
      case 'devanagari':
        return 'hi';
      case 'hangul':
        return 'ko';
      case 'kana':
        return 'ja';
      case 'cyrillic':
        return 'ru';
      default:
        return null;
    }
  };

  if (dominant !== 'latin' && dominant !== 'han' && dominant !== 'arabic' && dominant !== 'persian') {
    const language = scriptLanguage(dominant);
    if (language) {
      // Kana and Han belong to the same language, so Japanese confidence
      // combines both instead of penalizing kanji-heavy passages.
      const score = language === 'ja' ? shareOf('kana') + shareOf('han') : dominantShare;
      let confidence = score * (0.75 + 0.25 * sampleFactor);
      if (language === 'my') {
        const words = sample.toLowerCase();
        let hits = 0;
        for (const particle of BURMESE_PARTICLES) {
          if (words.includes(particle)) hits += 1;
        }
        confidence += Math.min(0.15, hits * 0.03);
      }
      if (language === 'ru') {
        const hits = countStopwordHits(sample, STOPWORDS.ru ?? []);
        if (hits >= 3) confidence += 0.1;
      }
      scores[language] = score;
      return finalize(scores, sample.length, confidence);
    }
  }

  if (dominant === 'persian' || dominant === 'arabic') {
    const persianShare = shareOf('persian');
    const arabicShare = shareOf('arabic');
    // Persian-specific letters inside the Arabic script settle the question.
    if (persianShare > 0.02 && persianShare >= arabicShare * 0.4) {
      scores.fa = persianShare + arabicShare;
      return finalize(scores, sample.length, (persianShare + arabicShare) * 0.95);
    }
    scores.ar = arabicShare + persianShare;
    return finalize(scores, sample.length, (arabicShare + persianShare) * 0.95);
  }

  if (dominant === 'han') {
    const kanaShare = shareOf('kana');
    if (kanaShare > 0.03) {
      scores.ja = dominantShare + kanaShare;
      return finalize(scores, sample.length, Math.min(0.95, dominantShare + kanaShare));
    }
    const totalHan = Math.max(1, hanSimplified + hanTraditional);
    if (hanTraditional / totalHan > 0.35) {
      scores['zh-Hant'] = dominantShare;
      return finalize(scores, sample.length, dominantShare * 0.95);
    }
    scores.zh = dominantShare;
    return finalize(scores, sample.length, dominantShare * 0.95);
  }

  // Latin script: separate languages with stopword + distinctive-char evidence.
  const latinShare = shareOf('latin');
  const words = tokenizeWords(sample);
  // Evidence and its denominator must cover the same window: counting
  // stopword tokens over every word while dividing by a 400-word cap would
  // inflate long samples instead.
  const window = words.slice(0, 400);
  const checked = Math.max(1, window.length);
  const scoresLatin: Record<string, number> = {};

  // Evidence is the stopword TOKEN share - what fraction of the running words
  // are that language's stopwords (prose runs ~15-25%). It used to be
  // "distinct stopword types present" divided by the word count: a type count
  // is capped at ~19 while the denominator grew to 400, so confidence FELL as
  // evidence accumulated and every real document tripped the confirm banner.
  let bestLanguage = 'en';
  let bestEvidence = 0;
  for (const language of LATIN_CANDIDATES) {
    const value = countStopwordTokens(window, STOPWORDS[language] ?? []) / checked;
    scoresLatin[language] = value;
    if (value > bestEvidence) {
      bestEvidence = value;
      bestLanguage = language;
    }
  }

  // Distinctive characters (umlauts, tilde-n, Vietnamese vowels) break ties
  // when the text is too short for reliable stopword statistics.
  if (bestEvidence === 0) {
    const hints: readonly [RegExp, string][] = [
      [/[äöüß]/, 'de'],
      [/[ãõ]/, 'pt'],
      [/[ñ¿¡]/, 'es'],
      [/[ăâêôơưđ]/, 'vi'],
    ];
    for (const [pattern, language] of hints) {
      if (pattern.test(sample)) {
        bestLanguage = language;
        bestEvidence = 0.04;
        break;
      }
    }
    // Every candidate scored 0; keep a single non-zero entry so `finalize`
    // cannot report `unknown` for stopword-free text - the confidence below
    // stays low, so the UI still asks instead of guessing.
    for (const language of LATIN_CANDIDATES) scoresLatin[language] = 0;
    scoresLatin[bestLanguage] = bestEvidence > 0 ? 0.04 : Math.max(latinShare * 0.5, 0.35);
  }

  // Confidence = evidence strength, tempered for short samples and scaled by
  // the Latin share so mixed-script text stays below the confirm threshold
  // even when one Latin language clearly leads.
  const confidence =
    bestEvidence > 0
      ? (0.35 + Math.min(0.55, bestEvidence * 6) * (0.7 + 0.3 * sampleFactor)) * latinShare
      : 0.35;
  return finalize(scoresLatin, sample.length, confidence);
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function countStopwordHits(words: string | readonly string[], stopwords: readonly string[]): number {
  const set = typeof words === 'string' ? new Set(tokenizeWords(words)) : new Set(words);
  let hits = 0;
  for (const stopword of stopwords) {
    if (set.has(stopword)) hits += 1;
  }
  return hits;
}

/** Stopword OCCURRENCES among `words` (frequency evidence, not distinct types). */
function countStopwordTokens(words: readonly string[], stopwords: readonly string[]): number {
  const set = new Set(stopwords);
  let hits = 0;
  for (const word of words) {
    if (set.has(word)) hits += 1;
  }
  return hits;
}

export { LANGUAGE_CONFIRM_THRESHOLD };
