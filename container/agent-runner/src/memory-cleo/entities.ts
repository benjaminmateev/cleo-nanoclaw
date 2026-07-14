export type EntityType = 'person' | 'project' | 'process' | 'business' | 'meeting' | 'decision';

export interface EntityNote {
  title: string;
  type: EntityType;
  body: string;
  links: string[];
}

const TYPE_FOLDER: Record<EntityType, string> = {
  person: 'people',
  project: 'projects',
  process: 'processes',
  business: 'business',
  meeting: 'meetings',
  decision: 'decisions',
};

export function folderForType(type: EntityType): string {
  return TYPE_FOLDER[type];
}

export function titleToFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}.md`;
}

export function relPathFor(type: EntityType, title: string): string {
  return `${folderForType(type)}/${titleToFilename(title)}`;
}

export function extractLinks(markdown: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const name = (m[1] ?? '').trim();
    if (name && !links.includes(name)) links.push(name);
  }
  return links;
}

export function serializeNote(note: EntityNote): string {
  const linkLines = note.links.map((l) => `- [[${l}]]`).join('\n');
  const linksSection = note.links.length > 0 ? `\n\n## Links\n${linkLines}\n` : '\n';
  return `# ${note.title}\n\n${note.body.trim()}\n${linksSection}`;
}

export function parseNote(type: EntityType, title: string, markdown: string): EntityNote {
  const withoutHeading = markdown.replace(/^#\s+.*(\r?\n)?/, '');
  const [bodyPart = ''] = withoutHeading.split(/\n##\s+Links/);
  return {
    title,
    type,
    body: bodyPart.trim(),
    links: extractLinks(markdown),
  };
}
