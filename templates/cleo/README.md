# Cleo — AI Executive Assistant template

Stamps a Cleo agent group: EA persona + Gmail / Google Calendar / Todoist MCP
tools + (documented below) the two heartbeat tasks. One stamp = one customer.

```bash
ncl groups create --template cleo --name "Cleo <customer>"
```

Templates carry **no secrets and no mounts**, so a stamped group needs the
per-customer steps below before it works.

## Prerequisites (per host, once)

1. Container image built with the Gmail + Calendar MCP binaries — the
   `add-gmail-tool` and `add-gcal-tool` skills' Dockerfile edits are on this
   fork's `main`; just `./container/build.sh`.
2. OneCLI running with the Google OAuth client configured (`onecli-local`
   client in the `cleo-app` Google Cloud project). Redirect URIs are
   per-provider: `http://127.0.0.1:10254/v1/apps/google-calendar/callback`
   (Gmail's shows on its connect form).
3. Credential stubs on disk (identical for every customer — they contain only
   `onecli-managed` placeholders): `~/.gmail-mcp/` and `~/.calendar-mcp/` per
   the two skills' Phase 1.

## Per-customer steps (after stamping)

1. **Connect OneCLI apps as the customer**: OneCLI web UI → Apps → Gmail →
   Connect, then Google Calendar → Connect (the customer signs into Google).
   The customer's OneCLI agent must have `secretMode: all` (or the Google
   secrets assigned).
2. **Todoist token** (replaces the `SET_PER_CUSTOMER` placeholder — never
   commit a real key):

   ```bash
   ncl groups config add-mcp-server --id <group-id> --name todoist \
     --command npx --args '["-y","@doist/todoist-mcp"]' \
     --env '{"TODOIST_API_KEY":"<customer-token>"}'
   ```

3. **Stub mounts** (no `add-mount` verb yet — nanoclaw#2395; DB edit via
   `scripts/q.ts`, see the add-gmail-tool skill Phase 3 for the exact SQL):
   `~/.gmail-mcp` → `.gmail-mcp`, `~/.calendar-mcp` → `.calendar-mcp`.
4. **Wire a channel**: `/manage-channels` or `ncl wirings create` (Telegram
   bot per customer).
5. **Heartbeats** (instance TZ; 4 fires/day is the ungated cap):

   ```bash
   ncl tasks create --group <group-id> --name "morning briefing" \
     --recurrence "0 7 * * *" \
     --prompt "Morning briefing: check today+tomorrow on the calendar, unread or important email in the inbox, and Todoist tasks due today or overdue. Send ONE concise briefing message: time-sensitive things first, then what needs a decision or action, then a one-line day overview. Plain text, no markdown. If a category is empty, skip it silently."

   ncl tasks create --group <group-id> --name "email triage" \
     --recurrence "0 8,12,16,20 * * *" \
     --prompt "Email triage sweep: search the inbox for unread emails received in the last 5 hours. If anything is urgent, time-sensitive, or clearly needs the user to act or reply, send ONE short message summarizing just those items (sender, subject, why it matters). If nothing meets that bar, send no message at all and finish silently."
   ```

## Notes

- Memory is automatic: the OpenCode provider's Cleo memory engine
  (`container/agent-runner/src/memory-cleo/`) extracts and recalls facts per
  group — nothing to configure here.
- Provider/model are set on the install, not the template
  (`OPENCODE_MODEL=cleo/cleo-simple` via LiteLLM).
