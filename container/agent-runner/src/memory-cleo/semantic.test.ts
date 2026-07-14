import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createSemanticIndex } from './semantic.js';

const fakeEmbed = async (t: string): Promise<number[]> => {
  const l = t.toLowerCase();
  return [l.includes('warehouse') || l.includes('storage') ? 1 : 0, l.includes('coffee') ? 1 : 0, l.length / 100];
};

describe('semantic index', () => {
  let dir: string; let indexPath: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'cleo-vec-')); indexPath = path.join(dir, 'index.json'); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('retrieves the semantically closest id', async () => {
    const idx = createSemanticIndex({ embed: fakeEmbed, indexPath });
    await idx.index('people/sara.md', 'Sara runs the warehouse lease');
    await idx.index('people/bob.md', 'Bob likes coffee');
    const hits = await idx.retrieve('who handles the storage facility?', 2);
    expect(hits[0]).toBe('people/sara.md');
  });

  it('persists and reloads', async () => {
    const idx = createSemanticIndex({ embed: fakeEmbed, indexPath });
    await idx.index('a.md', 'warehouse');
    await idx.persist();
    const raw = JSON.parse(await readFile(indexPath, 'utf8'));
    expect(raw.length).toBe(1);
    const idx2 = createSemanticIndex({ embed: fakeEmbed, indexPath });
    const hits = await idx2.retrieve('warehouse', 1);
    expect(hits[0]).toBe('a.md');
  });
});
