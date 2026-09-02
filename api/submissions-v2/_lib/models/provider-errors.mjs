export class ModelProviderError extends Error {
  constructor(code, message, { retryable = false, status = null, provider = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ModelProviderError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.provider = provider;
  }
}

export const TRANSIENT_PROVIDER_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function safeProviderError(provider, status, code = "MODEL_PROVIDER_ERROR") {
  const retryable = TRANSIENT_PROVIDER_STATUSES.has(Number(status));
  return new ModelProviderError(
    code,
    `${provider} model request failed${status ? ` with status ${status}` : ""}`,
    { retryable, status: Number(status) || null, provider },
  );
}

export async function responseJson(response, provider) {
  if (!response || typeof response !== "object") {
    throw new ModelProviderError("MODEL_RESPONSE_MISSING", `${provider} returned no response`, {
      retryable: true,
      provider,
    });
  }
  if (!response.ok) throw safeProviderError(provider, response.status);
  try {
    return await response.json();
  } catch (cause) {
    throw new ModelProviderError("MODEL_RESPONSE_INVALID_JSON", `${provider} returned invalid JSON`, {
      retryable: true,
      provider,
      cause,
    });
  }
}
