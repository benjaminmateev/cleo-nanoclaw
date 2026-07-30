/**
 * Task-list projection tests.
 *
 * The failures that matter here are duplication (a sweep re-pushing tasks the
 * customer already has) and a broken completion path (ticking a task in Todoist
 * not closing the commitment, so Cleo nags about something already done).
 */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openRecords, schemaVersion, SCHEMA_VERSION } from './schema.js';
import {
  upsertCommitment, commitmentsToProject, recordProjection,
  closeFromProjection, pendingProjections, openCommitments,
} from './store.js';
import {
  taskTitle, taskDescription, parseCommitmentId, todoistAddArgs, renderMarkdown,
} from './tasklist.js';

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-tasklist-'));
  const { db } = openRecords(dir);
  return db;
}

const MINE = {
  direction: 'mine' as const,
  counterparty: 'Marcus',
  what: 'send the pricing',
  promisedOn: '2026-07-20T09:00:00Z',
  source: 'email-sent',
  sourceRef: 'msg-1',
  sourceQuote: "I'll send the pricing on Monday",
};

// --- rendering --------------------------------------------------------------

test('a task I owe leads with the person; one I am owed says Chase', () => {
  expect(taskTitle({ ...MINE, id: 'x' })).toBe('Marcus: send the pricing');
  expect(taskTitle({ ...MINE, id: 'x', direction: 'theirs', what: 'the quote' }))
    .toBe('Chase Marcus: the quote');
});

test('a task with no counterparty still renders', () => {
  expect(taskTitle({ ...MINE, id: 'x', counterparty: null })).toBe('send the pricing');
});

test('the description carries the source quote — the reason the list is trusted', () => {
  const d = taskDescription({ ...MINE, id: 'abc' });
  expect(d).toContain("I'll send the pricing on Monday");
  expect(d).toContain('Promised 2026-07-20');
});

test('the commitment id round-trips through the description', () => {
  const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const d = taskDescription({ ...MINE, id });
  expect(parseCommitmentId(d)).toBe(id);
  expect(parseCommitmentId('no marker here')).toBe(null);
  expect(parseCommitmentId(null)).toBe(null);
});

test('an undated promise gets NO due date — never invent one', () => {
  // The majority of promises carry no date. Guessing would fill the customer's
  // task app with deadlines they never agreed to.
  const args = todoistAddArgs({ ...MINE, id: 'x', dueOn: null });
  expect(args.dueString).toBeUndefined();

  const dated = todoistAddArgs({ ...MINE, id: 'x', dueOn: '2026-08-01T00:00:00Z' });
  expect(dated.dueString).toBe('2026-08-01');
});

test('markdown projection separates what I owe from what I am waiting for', () => {
  const md = renderMarkdown([
    { ...MINE, id: 'a' },
    { ...MINE, id: 'b', direction: 'theirs', what: 'the signed contract', counterparty: 'Anna' },
  ], new Date('2026-07-30T12:00:00Z'));
  expect(md).toContain('## What I owe');
  expect(md).toContain('## What I am waiting for');
  expect(md).toContain('**Marcus** — send the pricing');
  expect(md).toContain('**Anna** — the signed contract');
  // Checkbox syntax so it reads as a list in any markdown viewer.
  expect(md).toContain('- [ ]');
});

test('markdown projection says so when a section is empty', () => {
  const md = renderMarkdown([{ ...MINE, id: 'a' }]);
  expect(md).toContain('_Nothing open._');
});

// --- idempotence and completion --------------------------------------------

test('a commitment is offered for projection once, then not again', () => {
  const db = fresh();
  const { id } = upsertCommitment(db, MINE);

  expect((commitmentsToProject(db, 'todoist') as unknown[]).length).toBe(1);
  recordProjection(db, id, 'todoist', 'todoist-task-1');
  // The core anti-duplication guarantee: a second sweep pushes nothing.
  expect((commitmentsToProject(db, 'todoist') as unknown[]).length).toBe(0);
});

test('projections are per-target — pushing to Todoist does not satisfy markdown', () => {
  const db = fresh();
  const { id } = upsertCommitment(db, MINE);
  recordProjection(db, id, 'todoist', 't1');
  expect((commitmentsToProject(db, 'markdown') as unknown[]).length).toBe(1);
});

test('completing the task in Todoist closes the commitment in SQLite', () => {
  const db = fresh();
  const { id } = upsertCommitment(db, MINE);
  recordProjection(db, id, 'todoist', 'todoist-task-1');

  expect(closeFromProjection(db, 'todoist', 'todoist-task-1').closed).toBe(true);
  expect((openCommitments(db) as unknown[]).length).toBe(0);
  // And it must not be re-pushed after closing.
  expect((commitmentsToProject(db, 'todoist') as unknown[]).length).toBe(0);
});

test('completing an unknown external id is a no-op, not a crash', () => {
  const db = fresh();
  expect(closeFromProjection(db, 'todoist', 'never-seen').closed).toBe(false);
});

test('pendingProjections lists what to poll, and drops it once completed', () => {
  const db = fresh();
  const a = upsertCommitment(db, MINE);
  const b = upsertCommitment(db, { ...MINE, what: 'send the deck', sourceRef: 'msg-2' });
  recordProjection(db, a.id, 'todoist', 't1');
  recordProjection(db, b.id, 'todoist', 't2');
  expect((pendingProjections(db, 'todoist') as unknown[]).length).toBe(2);

  closeFromProjection(db, 'todoist', 't1');
  const pending = pendingProjections(db, 'todoist') as Array<{ external_id: string }>;
  expect(pending.map((p) => p.external_id)).toEqual(['t2']);
});

test('deleting a commitment removes its projection rows (FK cascade)', () => {
  const db = fresh();
  const { id } = upsertCommitment(db, MINE);
  recordProjection(db, id, 'todoist', 't1');
  db.query('DELETE FROM commitments WHERE id = ?').run(id);
  expect(db.query('SELECT count(*) c FROM task_projections').get().c).toBe(0);
});

test('schema version is recorded as current even on an already-created db', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-ver-'));
  openRecords(dir).close();
  const { db } = openRecords(dir);   // second open, table already exists
  expect(schemaVersion(db)).toBe(SCHEMA_VERSION);
});
