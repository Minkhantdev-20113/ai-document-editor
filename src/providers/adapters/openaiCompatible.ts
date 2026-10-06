import { classifyProviderError } from '../classify';
import type { CompletionRequest, CompletionResult, ProviderAdapter, ProviderDescriptor } from '../types';

interface OpenAiMessage {
  readonly role: string;
  readonly content: string;
}

interface OpenAiBody {
  readonly model: string;
  readonly messages: readonly OpenAiMessage[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly response_format?: { readonly type: 'json_object' };
}

interface OpenAiResponse {
  readonly choices?: readonly { readonly message?: { readonly content?: string }; readonly finish_reason?: string }[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  };
  readonly error?: { readonly message?: string; readonly code?: string };
}

/**
 * Adapter factory for every OpenAI-compatible chat/completions endpoint
 * (Groq, OpenRouter, self-hosted servers).
 */
export function createOpenAiCompatibleAdapter(
  descriptor: ProviderDescriptor,
  overrides?: { baseUrl?: string | null },
): ProviderAdapter {
  const baseUrl = (overrides?.baseUrl ?? '').replace(/\/+$/, '');

  return {
    descriptor,
    buildHeaders(apiKey) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      };
      if (descriptor.id === 'openrouter') {
        headers['HTTP-Referer'] = typeof location !== 'undefined' ? location.origin : 'https://localhost';
        headers['X-Title'] = 'AI Document Translator';
      }
      return headers;
    },
    buildRequestBody(request: CompletionRequest): OpenAiBody {
      const wantsJson =
        request.responseFormat === 'json' && descriptor.capabilities.jsonMode;
      return {
        model: request.model,
        messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
        // Only sent when the provider advertises JSON mode - an endpoint that
        // does not understand response_format would reject the whole request.
        ...(wantsJson ? { response_format: { type: 'json_object' as const } } : {}),
      };
    },
    parseResponseBody(payload: unknown, model?: string): CompletionResult {
      const response = payload as OpenAiResponse;
      const text = response.choices?.[0]?.message?.content ?? '';
      const cached = response.usage?.prompt_tokens_details?.cached_tokens;
      return {
        text,
        model: model ?? 'unknown',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          ...(cached ? { cachedTokens: cached } : {}),
        },
        finishReason: response.choices?.[0]?.finish_reason ?? null,
      };
    },
    mapError(status, payload, headers) {
      const body = payload as OpenAiResponse | undefined;
      return classifyProviderError({
        status,
        ...(body?.error?.message ? { message: body.error.message } : {}),
        ...(headers ? { headers } : {}),
      });
    },
    probeEndpoint() {
      return `${baseUrl}/models`;
    },
    completionEndpoint() {
      return `${baseUrl}/chat/completions`;
    },
    parseProbeResponse(payload) {
      const body = payload as { data?: readonly { id?: string }[] } | undefined;
      return { models: (body?.data ?? []).map((model) => model.id ?? '').filter(Boolean) };
    },
  };
}
