import { describe, expect, it } from 'vitest';
import { detectLanguage, LANGUAGE_CONFIRM_THRESHOLD } from './languageDetect';

const BURMESE_SAMPLE = [
  'မြန်မာဘာသာစကားသည် ကမ္ဘာပေါ်တွင် အသုံးပြုသူ များစွာရှိသော ဘာသာစကားတစ်ခုဖြစ်သည်။',
  'ဤစာရွက်စာတမ်းကို စမ်းသပ်ရန် ရေးသားထားခြင်း ဖြစ်သည်။',
  'စကားပြောဆိုမှုနှင့် ရေးသားမှု နှစ်မျိုးစလုံးတွင် သဒ္ဒါများကို အဓိကထားသည်။',
].join(' ');

const ENGLISH_SAMPLE = [
  'The document is ready for review and the reviewer has checked the pages with annotations.',
  'This report was written for the team that maintains the system, and it will be shared with all users.',
  'Every page contains text that can be extracted and translated into other languages with care.',
].join(' ');

const FRENCH_SAMPLE =
  "Le document est prêt pour la révision et le réviseur a vérifié les pages avec les annotations. Il faut que le contenu soit clair pour les utilisateurs avec les outils de traduction.";

const GERMAN_SAMPLE =
  "Der Bericht wurde für das team erstellt und ist mit den benutzern zu teilen. Die seiten werden nicht übersetzt, wenn die daten fehlen.";

const SPANISH_SAMPLE =
  'El documento está listo para la revisión y el revisor ha verificado las páginas con las anotaciones. No es posible traducir todo sin las claves de los usuarios.';

describe('detectLanguage', () => {
  it('detects Burmese with high confidence', () => {
    const result = detectLanguage(BURMESE_SAMPLE);
    expect(result.code).toBe('my');
    expect(result.confidence).toBeGreaterThan(LANGUAGE_CONFIRM_THRESHOLD);
    expect(result.sampleChars).toBeGreaterThan(0);
  });

  it('detects English from stopwords', () => {
    const result = detectLanguage(ENGLISH_SAMPLE);
    expect(result.code).toBe('en');
    expect(result.confidence).toBeGreaterThan(LANGUAGE_CONFIRM_THRESHOLD);
  });

  it('separates French, German and Spanish', () => {
    expect(detectLanguage(FRENCH_SAMPLE).code).toBe('fr');
    expect(detectLanguage(GERMAN_SAMPLE).code).toBe('de');
    expect(detectLanguage(SPANISH_SAMPLE).code).toBe('es');
  });

  it('detects Thai from its script', () => {
    const result = detectLanguage('เอกสารนี้ใช้สำหรับการทดสอบการแปลภาษา ซึ่งต้องมีความแม่นยำสูงและตรวจสอบได้');
    expect(result.code).toBe('th');
    expect(result.confidence).toBeGreaterThan(LANGUAGE_CONFIRM_THRESHOLD);
  });

  it('detects Simplified and Traditional Chinese', () => {
    const simplified = detectLanguage('这个文档用于测试翻译系统的结构分析能力，必须准确无误。');
    expect(simplified.code).toBe('zh');
    expect(simplified.confidence).toBeGreaterThan(LANGUAGE_CONFIRM_THRESHOLD);

    const traditional = detectLanguage('這個文件用於測試翻譯系統的結構分析能力，必須準確無誤。');
    expect(traditional.code).toBe('zh-Hant');
  });

  it('detects Japanese when kana is present', () => {
    const result = detectLanguage('この文書は翻訳システムのテスト用です。構造解析の精度を確認します。');
    expect(result.code).toBe('ja');
    expect(result.confidence).toBeGreaterThan(LANGUAGE_CONFIRM_THRESHOLD);
  });

  it('detects Korean from Hangul', () => {
    const result = detectLanguage('이 문서는 번역 시스템의 구조 분석을 테스트하기 위한 문서입니다.');
    expect(result.code).toBe('ko');
  });

  it('detects Russian from Cyrillic', () => {
    const result = detectLanguage('Этот документ используется для проверки системы перевода текстов и структуры страниц.');
    expect(result.code).toBe('ru');
    expect(result.confidence).toBeGreaterThan(LANGUAGE_CONFIRM_THRESHOLD);
  });

  it('requires confirmation for heavily mixed content', () => {
    const mixed = `${BURMESE_SAMPLE} ${ENGLISH_SAMPLE}`;
    const result = detectLanguage(mixed);
    expect(result.confidence).toBeLessThan(LANGUAGE_CONFIRM_THRESHOLD);
  });

  it('returns low confidence for stopword-free text', () => {
    const result = detectLanguage('Hello world example text here okay thanks bye.');
    expect(result.confidence).toBeLessThan(LANGUAGE_CONFIRM_THRESHOLD);
  });

  it('handles empty and tiny input honestly', () => {
    expect(detectLanguage('')).toEqual({ code: 'unknown', confidence: 0, scores: {}, sampleChars: 0 });
    expect(detectLanguage('   \n\t ').confidence).toBe(0);
    expect(detectLanguage('x').code).toBe('unknown');
  });

  it('normalizes scores to a 0..1 range', () => {
    const result = detectLanguage(ENGLISH_SAMPLE);
    const total = Object.values(result.scores).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 2);
    for (const value of Object.values(result.scores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
