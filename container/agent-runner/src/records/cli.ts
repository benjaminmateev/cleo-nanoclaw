#!/usr/bin/env bun
/**
 * `cleo-records` — the agent's interface to its own structured memory.
 *
 * Runs INSIDE the agent container against the group's local records.db. It is a
 * separate binary from `ncl` on purpose: `ncl` talks to the host over a socket
 * and its write verbs are approval-gated, which is correct for changing
 * infrastructure and wrong for "note the invoice I just read". These records are
 * the agent's own working memory, local to its container.
 *
 * Usage (the agent calls these via bash):
 *   cleo-records record        --json '{"commitments":[...],"invoices":[...]}'
 *   cleo-records due           [--days 14]
 *   cleo-records open          [--direction mine|theirs] [--stale-days 7]
 *   cleo-records review
 *   cleo-records plan          --target todoist
 *   cleo-records confirm       --target todoist --json '[{"commitmentId":"..","externalId":".."}]'
 *   cleo-records complete      --target todoist --external-id <id>
 *   cleo-records close         --id <commitment-id> [--status done|dropped]
 *   cleo-records markdown      [--write]
 *   cleo-records overdue-vendors
 *
 * All output is JSON on stdout so the agent can read it without parsing prose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openRecords } from './schema.js';
import {
  invoicesDue, invoicesNeedingReview, openCommitments, closeCommitment,
  closeFromProjection, vendorsOverdue,
} from './store.js';
import { recordSweep, projectionPlan, confirmProjection, markdownProjection, sweepSummary } from './sweep.js';

const MEMORY_ROOT = process.env.CLEO_MEMORY_ROOT || '/workspace/agent/memory';
const RECORDS_ROOT = path.join(MEMORY_ROOT, '.records');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(message: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(1);
}

const command = process.argv[2];
const { db } = openRecords(RECORDS_ROOT);

try {
  switch (command) {
    case 'record': {
      const raw = flag('json');
      if (!raw) fail('record needs --json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // A clear parse error beats a stack trace the model has to interpret.
        fail(`--json was not valid JSON: ${(e as Error).message}`);
      }
      const result = recordSweep(db, parsed as never);
      out({ ok: true, ...result, summary: sweepSummary(result) });
      break;
    }

    case 'due': {
      const days = Number(flag('days') ?? 14);
      const through = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
      out({ ok: true, through, invoices: invoicesDue(db, through) });
      break;
    }

    case 'open': {
      const direction = flag('direction') as 'mine' | 'theirs' | undefined;
      const staleDays = flag('stale-days');
      out({
        ok: true,
        commitments: openCommitments(db, {
          direction,
          staleAfterDays: staleDays == null ? undefined : Number(staleDays),
        }),
      });
      break;
    }

    case 'review':
      // Low-confidence LLM extractions — what Cleo should flag rather than assert.
      out({ ok: true, invoices: invoicesNeedingReview(db) });
      break;

    case 'plan': {
      const target = (flag('target') ?? 'todoist') as 'todoist' | 'markdown';
      out({ ok: true, ...projectionPlan(db, target) });
      break;
    }

    case 'confirm': {
      const target = (flag('target') ?? 'todoist') as 'todoist' | 'markdown';
      const raw = flag('json');
      if (!raw) fail('confirm needs --json');
      out({ ok: true, ...confirmProjection(db, target, JSON.parse(raw)) });
      break;
    }

    case 'complete': {
      const target = flag('target') ?? 'todoist';
      const externalId = flag('external-id');
      if (!externalId) fail('complete needs --external-id');
      out({ ok: true, ...closeFromProjection(db, target, externalId) });
      break;
    }

    case 'close': {
      const id = flag('id');
      if (!id) fail('close needs --id');
      const status = (flag('status') ?? 'done') as 'done' | 'dropped' | 'superseded';
      closeCommitment(db, id, status);
      out({ ok: true, id, status });
      break;
    }

    case 'markdown': {
      const md = markdownProjection(db);
      if (process.argv.includes('--write')) {
        const dest = path.join(MEMORY_ROOT, 'tasks', 'commitments.md');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, md);
        out({ ok: true, written: dest, bytes: md.length });
      } else {
        out({ ok: true, markdown: md });
      }
      break;
    }

    case 'overdue-vendors':
      out({ ok: true, vendors: vendorsOverdue(db) });
      break;

    default:
      fail(
        `unknown command ${command ?? '(none)'} — expected one of: ` +
          'record, due, open, review, plan, confirm, complete, close, markdown, overdue-vendors',
      );
  }
} finally {
  db.close();
}
