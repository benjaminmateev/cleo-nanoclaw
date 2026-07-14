import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface Entry { id: string; vector: number[] }

export interface SemanticIndex {
  index(id: string, text: string): Promise<void>;
  retrieve(query: string, k: number): Promise<string[]>;
  persist(): Promise<void>;
  size(): number;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createSemanticIndex(opts: { embed: (t: string) => Promise<number[]>; indexPath: string }): SemanticIndex {
  let entries: Entry[] | null = null;

  async function load(): Promise<Entry[]> {
    if (entries !== null) return entries;
    try {
      entries = JSON.parse(await readFile(opts.indexPath, 'utf8')) as Entry[];
    } catch {
      entries = [];
    }
    return entries;
  }

  return {
    async index(id, text) {
      const list = await load();
      const vector = await opts.embed(text);
      const existing = list.findIndex((e) => e.id === id);
      if (existing >= 0) list[existing] = { id, vector };
      else list.push({ id, vector });
    },
    async retrieve(query, k) {
      const list = await load();
      if (list.length === 0) return [];
      const qv = await opts.embed(query);
      return list
        .map((e) => ({ id: e.id, score: cosine(qv, e.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((s) => s.id);
    },
    async persist() {
      const list = await load();
      await mkdir(path.dirname(opts.indexPath), { recursive: true });
      await writeFile(opts.indexPath, JSON.stringify(list), 'utf8');
    },
    size() {
      return entries?.length ?? 0;
    },
  };
}
