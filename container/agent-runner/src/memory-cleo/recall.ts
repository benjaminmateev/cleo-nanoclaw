import type { KnowledgeBase } from './kb.js';
import type { SemanticIndex } from './semantic.js';
import { extractLinks, relPathFor } from './entities.js';

const TYPE_ORDER = ['person', 'project', 'process', 'business', 'meeting', 'decision'] as const;

async function resolveLink(kb: KnowledgeBase, title: string): Promise<string | null> {
  for (const t of TYPE_ORDER) {
    const rel = relPathFor(t, title);
    if ((await kb.read(rel)) !== null) return rel;
  }
  return null;
}

export async function recall(
  query: string,
  deps: { kb: KnowledgeBase; semantic: SemanticIndex; k?: number },
): Promise<string> {
  const entryIds = await deps.semantic.retrieve(query, deps.k ?? 3);
  if (entryIds.length === 0) return '';

  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const id of entryIds) {
    const md = await deps.kb.read(id);
    if (md === null || seen.has(id)) continue;
    seen.add(id);
    blocks.push(md.trim());
    for (const link of extractLinks(md)) {
      const nRel = await resolveLink(deps.kb, link);
      if (nRel && !seen.has(nRel)) {
        const nMd = await deps.kb.read(nRel);
        if (nMd !== null) { seen.add(nRel); blocks.push(nMd.trim()); }
      }
    }
  }
  return blocks.length === 0 ? '' : `Relevant memory:\n\n${blocks.join('\n\n---\n\n')}`;
}
