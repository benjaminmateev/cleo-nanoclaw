import type { KnowledgeBase } from './kb.js';
import type { CompletionRequest, CompletionResult } from './litellm-client.js';
import type { EntityType, EntityNote } from './entities.js';
import { parseNote, relPathFor, serializeNote } from './entities.js';

export interface ExtractorDeps {
  kb: KnowledgeBase;
  client: { complete(req: CompletionRequest): Promise<CompletionResult> };
  customerId: string;
  now?: () => Date;
}

export interface Extracted {
  title: string;
  type: EntityType;
  fact: string;
  links: string[];
}

const TYPES: EntityType[] = ['person', 'project', 'process', 'business', 'meeting', 'decision'];

const EXTRACT_PROMPT =
  'From the conversation, extract durable facts worth remembering long-term about the user\'s ' +
  'world: people, projects, processes, business info, meetings, decisions. Return a JSON array of ' +
  '{title, type, fact, links} where type is one of person|project|process|business|meeting|decision ' +
  'and links is an array of OTHER entity titles this one references. Return [] if nothing durable. ' +
  'JSON only, no prose.';

function reconcilePrompt(title: string, existing: string, fact: string): string {
  return `Entity: "${title}"\nExisting note body:\n${existing || '(none yet)'}\n\nNew fact to integrate:\n${fact}\n\n` +
    'Rewrite the note BODY (plain markdown, no heading, no Links section) integrating the new fact: ' +
    'merge, correct contradictions (prefer newer info), stay concise. Body only.';
}

function today(now: () => Date): string {
  const d = now();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function callText(deps: ExtractorDeps, prompt: string): Promise<string> {
  const res = await deps.client.complete({
    messages: [{ role: 'user', content: prompt }],
    signals: { message: 'extract memory', estimatedToolCalls: 1 },
    customerId: deps.customerId,
  });
  return res.content ?? '';
}

function parseExtracted(raw: string): Extracted[] {
  try {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end < 0) return [];
    const arr = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is Extracted =>
          !!x &&
          typeof (x as Extracted).title === 'string' &&
          TYPES.includes((x as Extracted).type) &&
          typeof (x as Extracted).fact === 'string',
      )
      .map((x) => ({ ...x, links: Array.isArray(x.links) ? x.links.filter((l) => typeof l === 'string') : [] }));
  } catch {
    return [];
  }
}

async function backupIfExists(deps: ExtractorDeps, title: string, oldMarkdown: string | null): Promise<void> {
  if (oldMarkdown === null) return;
  const rel = `log/_memory-changes/${today(deps.now ?? (() => new Date()))}.md`;
  const prior = (await deps.kb.read(rel)) ?? '';
  await deps.kb.upsert(rel, `${prior}\n## ${title} (superseded)\n\`\`\`\n${oldMarkdown}\n\`\`\`\n`);
}

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

async function existingTypeFor(deps: ExtractorDeps, title: string): Promise<EntityType | null> {
  for (const t of TYPES) {
    if ((await deps.kb.read(relPathFor(t, title))) !== null) return t;
  }
  return null;
}

export async function extractAndReconcile(transcript: string, deps: ExtractorDeps): Promise<string[]> {
  const items = parseExtracted(await callText(deps, `${EXTRACT_PROMPT}\n\nConversation:\n${transcript}`));
  const touched: string[] = [];

  for (const item of items) {
    try {
      const type = (await existingTypeFor(deps, item.title)) ?? item.type;
      const rel = relPathFor(type, item.title);
      const oldMarkdown = await deps.kb.read(rel);
      const existing = oldMarkdown === null ? null : parseNote(type, item.title, oldMarkdown);
      const reconciledBody = (await callText(deps, reconcilePrompt(item.title, existing?.body ?? '', item.fact))).trim();

      // Back up prior content BEFORE the upsert below overwrites it.
      await backupIfExists(deps, item.title, oldMarkdown);

      const note: EntityNote = {
        title: item.title,
        type,
        body: reconciledBody || item.fact,
        links: union(existing?.links ?? [], item.links),
      };
      await deps.kb.upsert(rel, serializeNote(note));
      touched.push(rel);

      // ponytail: neighbor stubs are last-write-wins on body within a batch, but
      // bodies are only the '(auto-created)' placeholder so nothing real is lost;
      // link unions are always safe. Add batch dedup only if this ever matters.
      for (const neighbor of item.links) {
        const nRel = relPathFor('project', neighbor);
        const nOld = await deps.kb.read(nRel);
        const nNote =
          nOld === null
            ? { title: neighbor, type: 'project' as EntityType, body: '(auto-created)', links: [item.title] }
            : (() => {
                const p = parseNote('project', neighbor, nOld);
                return { ...p, links: union(p.links, [item.title]) };
              })();
        await deps.kb.upsert(nRel, serializeNote(nNote));
      }
    } catch (err) {
      console.error(`memory: failed to reconcile ${item.title}`, err);
    }
  }
  return touched;
}
