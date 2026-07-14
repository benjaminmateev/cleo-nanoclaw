// Minimal LiteLLM completion client for the memory engine's extract/reconcile
// calls. The vendored extractor.ts expects a `{ complete(req) }` shape from
// Cleo's routing client, but only uses `messages`, `customerId`, and the
// returned `content` — tier routing is LiteLLM's job here, so this is a thin
// POST to /chat/completions on the cleo-simple alias. Bun-native (fetch only).

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Kept structurally compatible with Cleo's routing client so the vendored
// extractor imports these unchanged. `signals`/`tools` are accepted and
// ignored (LiteLLM handles routing); only `messages` is sent.
export interface CompletionRequest {
  messages: ChatMessage[];
  signals?: unknown;
  customerId: string;
  tools?: unknown;
}

export interface CompletionResult {
  content: string | null;
}

export interface LiteLlmClient {
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/**
 * @param baseUrl LiteLLM base, e.g. http://host.docker.internal:4000
 * @param apiKey  LiteLLM master key
 * @param model   routing alias (default cleo-simple)
 */
export function createLiteLlmClient(
  baseUrl: string,
  apiKey: string,
  model = 'cleo-simple',
): LiteLlmClient {
  return {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: req.messages }),
      });
      if (!res.ok) {
        throw new Error(`litellm-client: ${res.status} ${await res.text()}`);
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return { content: data.choices?.[0]?.message?.content ?? null };
    },
  };
}
