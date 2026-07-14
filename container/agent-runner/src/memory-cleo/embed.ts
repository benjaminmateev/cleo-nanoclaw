export function createEmbedder(litellmUrl: string, apiKey: string): (text: string) => Promise<number[]> {
  return async (text: string): Promise<number[]> => {
    const res = await fetch(`${litellmUrl}/embeddings`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'cleo-embed', input: text }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`embedder: request failed with status ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { data: { embedding: number[] }[] };
    return data.data[0]?.embedding ?? [];
  };
}
