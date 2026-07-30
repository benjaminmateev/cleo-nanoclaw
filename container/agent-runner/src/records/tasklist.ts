/**
 * Task-list projection.
 *
 * Cleo's commitments live in SQLite (see schema.ts). A task app — Todoist today,
 * others later — is a *projection* of that record, not a second home for it.
 *
 * Why this asymmetry rather than a two-way sync: SQLite holds things a task app
 * cannot represent at all — the verbatim source quote, the thread reference, the
 * direction (something I owe vs something I am owed), the extraction confidence,
 * the nudge history. If both sides could create and edit, they would drift, and
 * the usual outcome is duplicates plus a customer who trusts neither. So:
 *
 *   - CREATION flows one way:  SQLite -> task app.
 *   - COMPLETION flows the other: task app -> SQLite.
 *
 * That gives each direction exactly one owner. Ticking a task in Todoist closes
 * the commitment; Cleo never resurrects it.
 *
 * Customers with no task app get `markdown` — one document in the second brain,
 * surfaced read-only in the web app. No task database nobody asked for.
 */

export type TaskListKind = 'todoist' | 'markdown' | 'none';

export interface TaskListConfig {
  kind: TaskListKind;
  /** Todoist project to write into. Absent = inbox. */
  projectName?: string;
  /** Path of the markdown projection, relative to the memory root. */
  documentPath?: string;
}

export const DEFAULT_MARKDOWN_PATH = 'tasks/commitments.md';

/**
 * A commitment as the projection needs to see it. Deliberately a narrow shape
 * rather than the full DB row — the projection has no business reading
 * confidence scores or nudge timestamps.
 */
export interface ProjectableCommitment {
  id: string;
  direction: 'mine' | 'theirs';
  counterparty?: string | null;
  what: string;
  promisedOn: string;
  dueOn?: string | null;
  sourceQuote?: string | null;
}

/**
 * Render a commitment as a task title.
 *
 * The counterparty leads because that is how people search their own task list
 * ("what do I owe Marcus?"), and the direction is spelled out rather than
 * encoded in a label — a task app is read by a human, not parsed.
 */
export function taskTitle(c: ProjectableCommitment): string {
  const who = c.counterparty?.trim();
  if (c.direction === 'theirs') {
    return who ? `Chase ${who}: ${c.what}` : `Chase: ${c.what}`;
  }
  return who ? `${who}: ${c.what}` : c.what;
}

/**
 * The task description. Carries the evidence so the customer can judge a
 * commitment they do not remember making — the source quote is the whole reason
 * they will trust the list.
 */
export function taskDescription(c: ProjectableCommitment): string {
  const lines: string[] = [];
  if (c.sourceQuote) lines.push(`"${c.sourceQuote.trim()}"`);
  lines.push(`Promised ${c.promisedOn.slice(0, 10)} — noted by Cleo.`);
  // The id lets a later sweep recognise its own task without keeping a map,
  // which matters because Todoist ids are not stable across a project move.
  lines.push(`cleo:${c.id}`);
  return lines.join('\n');
}

/** Extract a Cleo commitment id from a task description, if present. */
export function parseCommitmentId(description: string | null | undefined): string | null {
  const m = /cleo:([0-9a-f-]{36})/i.exec(description ?? '');
  return m ? m[1] : null;
}

/**
 * Arguments for the Todoist `add-tasks` tool.
 *
 * Only a stated due date is passed through. Inventing one for an undated promise
 * would be the projection asserting a fact the record does not contain — and
 * undated promises are the majority, so a guessed date would fill the customer's
 * task app with fake deadlines.
 */
export function todoistAddArgs(c: ProjectableCommitment, projectName?: string) {
  const args: Record<string, unknown> = {
    content: taskTitle(c),
    description: taskDescription(c),
  };
  if (c.dueOn) args.dueString = c.dueOn.slice(0, 10);
  if (projectName) args.projectName = projectName;
  return args;
}

/**
 * Render the markdown projection for customers with no task app.
 *
 * Grouped by direction, then ordered by date, because "what do I owe" and "what
 * am I waiting for" are two different questions people ask at different moments.
 * Regenerated wholesale rather than patched — it is a view, and a stale view
 * that has been hand-edited is worse than one that is simply rewritten.
 */
export function renderMarkdown(commitments: ProjectableCommitment[], now = new Date()): string {
  const mine = commitments.filter((c) => c.direction === 'mine');
  const theirs = commitments.filter((c) => c.direction === 'theirs');
  const byDate = (a: ProjectableCommitment, b: ProjectableCommitment) =>
    (a.dueOn ?? a.promisedOn).localeCompare(b.dueOn ?? b.promisedOn);

  const line = (c: ProjectableCommitment) => {
    const who = c.counterparty ? `**${c.counterparty}** — ` : '';
    const due = c.dueOn ? ` _(due ${c.dueOn.slice(0, 10)})_` : '';
    const said = ` · said ${c.promisedOn.slice(0, 10)}`;
    return `- [ ] ${who}${c.what}${due}${said}`;
  };

  const out: string[] = [
    '# Open commitments',
    '',
    `_Maintained by Cleo. Last updated ${now.toISOString().slice(0, 16).replace('T', ' ')}._`,
    '',
  ];

  out.push('## What I owe', '');
  out.push(mine.length ? mine.sort(byDate).map(line).join('\n') : '_Nothing open._');
  out.push('', '## What I am waiting for', '');
  out.push(theirs.length ? theirs.sort(byDate).map(line).join('\n') : '_Nothing open._');
  out.push('');

  return out.join('\n');
}
