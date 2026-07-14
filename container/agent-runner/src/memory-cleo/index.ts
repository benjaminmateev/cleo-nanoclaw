// Cleo self-learning memory, ported onto the nanoclaw agent-runner.
//
// Wires the vendored engine (extract → reconcile → [[wikilink]] graph →
// semantic recall) to the container's memory volume and LiteLLM. Exposes two
// entry points the OpenCode provider calls:
//   - onExchange(exchange): after a turn, extract durable facts and index them
//   - recallFor(query):     before a turn, fetch relevant memory to inject
//
// Memory lives at /workspace/agent/memory/ (host-backed, survives recycle).
// Bun-native: the whole engine uses only node:fs/promises, node:path, fetch.

import path from 'node:path';
import { createKnowledgeBase, type KnowledgeBase } from './kb.js';
import { createEmbedder } from './embed.js';
import { createSemanticIndex, type SemanticIndex } from './semantic.js';
import { extractAndReconcile } from './extractor.js';
import { recall } from './recall.js';
import { createLiteLlmClient, type LiteLlmClient } from './litellm-client.js';

export interface MemoryExchange {
  prompt: string;
  result: string | null;
}

export interface CleoMemory {
  onExchange(exchange: MemoryExchange): Promise<void>;
  recallFor(query: string): Promise<string>;
}

const MEMORY_ROOT = '/workspace/agent/memory';
const INDEX_PATH = path.join(MEMORY_ROOT, '.semantic-index.json');

function log(msg: string): void {
  console.error(`[memory-cleo] ${msg}`);
}

/**
 * Build the memory subsystem from container env. Returns null (memory disabled)
 * if the LiteLLM endpoint/key aren't configured — the agent still runs, just
 * without learning, so a misconfig degrades gracefully instead of crashing.
 */
export function createCleoMemory(env: NodeJS.ProcessEnv = process.env): CleoMemory | null {
  const baseUrl = env.ANTHROPIC_BASE_URL;
  const apiKey = env.LITELLM_MASTER_KEY;
  if (!baseUrl || !apiKey) {
    log('disabled: ANTHROPIC_BASE_URL or LITELLM_MASTER_KEY not set');
    return null;
  }
  const customerId = env.CLEO_CUSTOMER_ID || env.OPENCODE_GROUP_ID || 'default';

  const kb: KnowledgeBase = createKnowledgeBase(MEMORY_ROOT);
  const embed = createEmbedder(baseUrl, apiKey);
  const semantic: SemanticIndex = createSemanticIndex({ embed, indexPath: INDEX_PATH });
  const client: LiteLlmClient = createLiteLlmClient(baseUrl, apiKey);

  return {
    async onExchange(exchange: MemoryExchange): Promise<void> {
      if (!exchange.result) return; // nothing to learn from an empty/failed turn
      const transcript = `User: ${exchange.prompt}\n\nAssistant: ${exchange.result}`;
      const touched = await extractAndReconcile(transcript, { kb, client, customerId });
      if (touched.length === 0) return;
      // Index the touched notes for semantic recall, then persist the index.
      for (const rel of touched) {
        const md = await kb.read(rel);
        if (md !== null) await semantic.index(rel, md);
      }
      await semantic.persist();
      log(`learned ${touched.length} note(s): ${touched.join(', ')}`);
    },

    async recallFor(query: string): Promise<string> {
      return recall(query, { kb, semantic });
    },
  };
}
