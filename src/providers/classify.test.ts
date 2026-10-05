import { describe, expect, it } from 'vitest';
import { classifyProviderError, parseRateLimitHeaders, parseRetryAfter } from './classify';

describe('provider error classification', () => {
  it('classifies a plain 429 as rate_limit (retryable)', () => {
    const result = classifyProviderError({ status: 429, message: 'Too many requests' });
    expect(result.class).toBe('rate_limit');
    expect(result.error.code).toBe('provider_rate_limited');
    expect(result.error.retryable).toBe(true);
  });

  it('classifies billing/quota 429 as quota_exceeded (not retryable)', () => {
    const result = classifyProviderError({
      status: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
    });
    expect(result.class).toBe('quota_exceeded');
    expect(result.error.code).toBe('provider_quota_exceeded');
    expect(result.error.retryable).toBe(false);
  });

  it('classifies insufficient_quota (OpenAI style) as quota_exceeded', () => {
    const result = classifyProviderError({
      status: 429,
      message: 'You exceeded your current quota.',
      providerStatus: 'insufficient_quota',
    });
    expect(result.class).toBe('quota_exceeded');
  });

  it('prefers rate_limit when the message names a per-minute window', () => {
    const result = classifyProviderError({
      status: 429,
      message:
        "Quota exceeded for quota metric 'GenerateContent requests' and limit 'GenerateContent requests per minute'",
    });
    expect(result.class).toBe('rate_limit');
    expect(result.error.retryable).toBe(true);
  });

  it('classifies Gemini RESOURCE_EXHAUSTED with exhausted-resource text as quota', () => {
    const result = classifyProviderError({
      status: 429,
      message: 'Resource has been exhausted (e.g. check quota)',
      providerStatus: 'RESOURCE_EXHAUSTED',
    });
    expect(result.class).toBe('quota_exceeded');
  });

  it('classifies 401/403 as auth', () => {
    for (const status of [401, 403]) {
      const result = classifyProviderError({ status, message: 'Unauthorized' });
      expect(result.class).toBe('auth');
      expect(result.error.code).toBe('provider_invalid_key');
    }
    const gemini = classifyProviderError({ status: 400, providerStatus: 'UNAUTHENTICATED' });
    expect(gemini.class).toBe('auth');
  });

  it('classifies unknown-model responses as invalid_model', () => {
    const notFound = classifyProviderError({ status: 404, message: 'Not Found' });
    expect(notFound.class).toBe('invalid_model');
    expect(notFound.error.code).toBe('provider_invalid_model');

    const badRequest = classifyProviderError({
      status: 400,
      message: 'The model `foo-9000` does not exist',
    });
    expect(badRequest.class).toBe('invalid_model');
    expect(badRequest.error.retryable).toBe(false);
  });

  it('classifies safety/content messages as content_policy', () => {
    const result = classifyProviderError({
      status: 400,
      message: 'The request was blocked due to SAFETY content policy',
    });
    expect(result.class).toBe('content_policy');
    expect(result.error.code).toBe('provider_content_policy');
    expect(result.error.retryable).toBe(false);
  });

  it('classifies 5xx as server_error (retryable)', () => {
    const result = classifyProviderError({ status: 503, message: 'Service unavailable' });
    expect(result.class).toBe('server_error');
    expect(result.error.code).toBe('provider_unavailable');
    expect(result.error.retryable).toBe(true);
  });

  it('classifies other 4xx as rejected (not retryable)', () => {
    const result = classifyProviderError({ status: 400, message: 'Bad request: max_tokens too large' });
    expect(result.class).toBe('rejected');
    expect(result.error.retryable).toBe(false);
  });

  it('always produces a code the dictionaries can render', () => {
    for (const status of [400, 401, 403, 404, 418, 429, 500, 502, 503]) {
      const result = classifyProviderError({ status });
      expect(result.error.code).toBeTruthy();
      expect(typeof result.error.message).toBe('string');
    }
  });
});

describe('rate-limit hints', () => {
  const NOW = 1_700_000_000_000;

  it('parses Retry-After seconds', () => {
    expect(parseRetryAfter('30', NOW)).toBe(30_000);
  });

  it('parses Retry-After HTTP dates', () => {
    const date = new Date(NOW + 45_000).toUTCString();
    expect(parseRetryAfter(date, NOW)).toBe(45_000);
  });

  it('returns undefined for missing or unparseable values', () => {
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
  });

  it('reads OpenAI/Groq style headers', () => {
    const hints = parseRateLimitHeaders(
      {
        'x-ratelimit-limit-requests': '30',
        'x-ratelimit-remaining-requests': '12',
        'x-ratelimit-limit-tokens': '100000',
        'x-ratelimit-remaining-tokens': '40000',
        'retry-after': '7',
      },
      NOW,
    );
    expect(hints.limitRequestsPerMinute).toBe(30);
    expect(hints.remainingRequests).toBe(12);
    expect(hints.limitTokensPerMinute).toBe(100_000);
    expect(hints.remainingTokens).toBe(40_000);
    expect(hints.retryAfterMs).toBe(7_000);
  });

  it('reads compact reset durations and absolute timestamps', () => {
    expect(parseRateLimitHeaders({ 'x-ratelimit-reset-requests': '1m30s' }, NOW).retryAfterMs).toBe(90_000);
    expect(parseRateLimitHeaders({ 'x-ratelimit-reset-requests': '45' }, NOW).retryAfterMs).toBe(45_000);
    expect(
      parseRateLimitHeaders({ 'x-ratelimit-reset': String(NOW / 1000 + 60) }, NOW).retryAfterMs,
    ).toBe(60_000);
  });

  it('ignores unknown headers instead of guessing', () => {
    expect(parseRateLimitHeaders({ 'x-custom-thing': '1' }, NOW)).toEqual({});
    expect(parseRateLimitHeaders(undefined, NOW)).toEqual({});
  });
});
