import { describe, expect, it } from 'vitest';
import { AppError, type AppErrorCode } from '../core/errors/appError';
import { rejectedRequestParam } from './aiProvider';

function rejection(message: string, code: AppErrorCode = 'provider_rejected'): AppError {
  return new AppError(message, { code, retryable: code === 'provider_rejected' });
}

describe('rejectedRequestParam', () => {
  it('recognises an endpoint that refuses the output budget', () => {
    expect(rejectedRequestParam(rejection('max_tokens must be less than or equal to 8192'))).toBe(
      'output_tokens',
    );
    expect(rejectedRequestParam(rejection('Invalid value for "max_completion_tokens"'))).toBe(
      'output_tokens',
    );
    expect(rejectedRequestParam(rejection('The maximum number of tokens was exceeded'))).toBe(
      'output_tokens',
    );
  });

  it('recognises an endpoint that refuses JSON mode', () => {
    expect(
      rejectedRequestParam(rejection('response_format is not supported by this model')),
    ).toBe('response_format');
    expect(rejectedRequestParam(rejection('Invalid "json_object" response format'))).toBe(
      'response_format',
    );
    expect(rejectedRequestParam(rejection('Unsupported responseMimeType: application/json'))).toBe(
      'response_format',
    );
  });

  it('leaves model-reply contract failures to the batch splitter', () => {
    expect(rejectedRequestParam(rejection('Translation response is missing 4 of 30 units'))).toBeNull();
    expect(rejectedRequestParam(rejection('Translation response was not valid JSON'))).toBeNull();
    expect(rejectedRequestParam(rejection('Translation response had an unexpected shape'))).toBeNull();
  });

  it('never spends an extra request on quota, rate-limit, auth or model errors', () => {
    expect(rejectedRequestParam(rejection('You exceeded your current quota', 'provider_quota_exceeded'))).toBeNull();
    expect(rejectedRequestParam(rejection('Rate limit reached', 'provider_rate_limited'))).toBeNull();
    expect(rejectedRequestParam(rejection('API key not valid', 'provider_invalid_key'))).toBeNull();
    expect(rejectedRequestParam(rejection('max_tokens is too large', 'provider_invalid_model'))).toBeNull();
  });
});
