import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export interface KnowledgeBase {
  seed(): Promise<void>;
  read(relPath: string): Promise<string | null>;
  upsert(relPath: string, content: string): Promise<void>;
  search(query: string): Promise<SearchHit[]>;
  appendLog(line: string, date?: Date): Promise<void>;
}

const SEED_DIRS = ['people', 'processes', 'business', 'projects', 'log'];

const SEED_STUBS: Record<string, string> = {
  'business/about.md': '# About\n\nPlaceholder — fill in details about the business.\n',
  'business/preferences.md': '# Preferences\n\nPlaceholder — fill in preferences and conventions.\n',
  'business/templates.md': '# Templates\n\nPlaceholder — fill in reusable templates.\n',
};

function resolveSafePath(root: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error(`Path must be relative: ${relPath}`);
  }
  if (!relPath.endsWith('.md')) {
    throw new Error(`Path must end in .md: ${relPath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relPath);

  if (!resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes knowledge base root: ${relPath}`);
  }

  return resolved;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function createKnowledgeBase(root: string): KnowledgeBase {
  const resolvedRoot = path.resolve(root);

  async function read(relPath: string): Promise<string | null> {
    const target = resolveSafePath(resolvedRoot, relPath);
    try {
      return await readFile(target, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async function upsert(relPath: string, content: string): Promise<void> {
    const target = resolveSafePath(resolvedRoot, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  async function seed(): Promise<void> {
    for (const dir of SEED_DIRS) {
      await mkdir(path.join(resolvedRoot, dir), { recursive: true });
    }

    for (const [relPath, stub] of Object.entries(SEED_STUBS)) {
      const target = resolveSafePath(resolvedRoot, relPath);
      if (!(await fileExists(target))) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, stub, 'utf8');
      }
    }
  }

  async function search(query: string): Promise<SearchHit[]> {
    if (query.length === 0) {
      return [];
    }

    const needle = query.toLowerCase();
    const files = await walkMarkdownFiles(resolvedRoot);
    const hits: SearchHit[] = [];

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.toLowerCase().includes(needle)) {
          hits.push({
            file: path.relative(resolvedRoot, filePath).split(path.sep).join('/'),
            line: i + 1,
            text: line.trim(),
          });
        }
      }
    }

    return hits;
  }

  async function appendLog(line: string, date: Date = new Date()): Promise<void> {
    const relPath = `log/${formatDate(date)}.md`;
    const existing = await read(relPath);
    const heading = `# ${formatDate(date)}\n\n`;
    const bullet = `- ${formatTime(date)} ${line}\n`;
    const nextContent = existing === null ? heading + bullet : existing + bullet;
    await upsert(relPath, nextContent);
  }

  return { seed, read, upsert, search, appendLog };
}
