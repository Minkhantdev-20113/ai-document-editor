import { PROVIDER_CATALOG, defaultBaseUrl } from '../catalog';
import { classifyProviderError } from '../classify';
import type { CompletionRequest, CompletionResult, ProviderAdapter, ProviderDescriptor } from '../types';

interface GeminiPart {
  readonly text?: string;
}

interface GeminiContent {
  readonly role: string;
  readonly parts: readonly GeminiPart[];
}

interface GeminiBody {
  readonly contents: readonly GeminiContent[];
  readonly generationConfig?: {
    readonly maxOutputTokens?: number;
    readonly temperature?: number;
    readonly responseMimeType?: string;
  };
}

interface GeminiResponse {
  readonly candidates?: readonly {
    readonly content?: GeminiContent;
    readonly finishReason?: string;
  }[];
  readonly usageMetadata?: {
    readonly promptTokenCount?: number;
    readonly candidatesTokenCount?: number;
    readonly cachedContentTokenCount?: number;
  };
  readonly error?: { readonly code?: number; readonly message?: string; readonly status?: string };
}

/**
 * Google Gemini adapter.
 * The key travels in the `x-goog-api-key` header - never in the URL - so it
 * cannot leak through request logs or referrers.
 */
export function createGeminiAdapter(overrides?: { baseUrl?: string | null }): ProviderAdapter {
  const descriptor: ProviderDescriptor = PROVIDER_CATALOG.gemini;
  const baseUrl = (overrides?.baseUrl || defaultBaseUrl('gemini') || '').replace(/\/+$/, '');

  return {
    descriptor,
    buildHeaders(apiKey) {
      return {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      };
    },
    buildRequestBody(request: CompletionRequest): GeminiBody {
      const contents: GeminiContent[] = [];
      const system = request.messages.filter((message) => message.role === 'system');
      const rest = request.messages.filter((message) => message.role !== 'system');
      if (system.length > 0) {
        contents.push({
          role: 'user',
          parts: [{ text: system.map((message) => message.content).join('\n\n') }],
        });
        contents.push({ role: 'model', parts: [{ text: 'Understood.' }] });
      }
      for (const message of rest) {
        contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
      }
      const generationConfig: {
        maxOutputTokens?: number;
        temperature?: number;
        responseMimeType?: string;
      } = {};
      if (request.maxOutputTokens) generationConfig.maxOutputTokens = request.maxOutputTokens;
      if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
      // Gemini supports native JSON output mode for every model in the catalog.
      if (request.responseFormat === 'json') generationConfig.responseMimeType = 'application/json';
      return {
        contents,
        ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      };
    },
    parseResponseBody(payload: unknown, model?: string): CompletionResult {
      const response = payload as GeminiResponse;
      const candidate = response.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');
      const usage = response.usageMetadata ?? {};
      return {
        text,
        model: model ?? 'gemini',
        usage: {
          inputTokens: usage.promptTokenCount ?? 0,
          outputTokens: usage.candidatesTokenCount ?? 0,
          ...(usage.cachedContentTokenCount ? { cachedTokens: usage.cachedContentTokenCount } : {}),
        },
        finishReason: candidate?.finishReason ?? null,
      };
    },
    mapError(status, payload, headers) {
      const body = payload as GeminiResponse | undefined;
      return classifyProviderError({
        status,
        ...(body?.error?.message ? { message: body.error.message } : {}),
        ...(body?.error?.status ? { providerStatus: body.error.status } : {}),
        ...(headers ? { headers } : {}),
      });
    },
    probeEndpoint() {
      return `${baseUrl}/models`;
    },
    completionEndpoint(model) {
      return `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    },
    parseProbeResponse(payload) {
      const body = payload as { models?: readonly { name?: string }[] } | undefined;
      const models = (body?.models ?? [])
        .map((model) => (model.name ?? '').replace(/^models\//, ''))
        .filter(Boolean);
      return { models };
    },
  };
}
