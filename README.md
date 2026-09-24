# Assignment Planner

A single-user Telegram assistant that turns text, screenshots, and syllabus PDFs into reviewed Google Calendar deadlines, tracks completion, and sends scheduled Telegram reminders. Designed for free service tiers; no paid fallback is implemented.

## Architecture

```text
Telegram webhook -> authenticated durable D1 inbox
                               |
                  scheduled Worker (every minute)
                               |
            commands OR Gemini structured extraction
                               |
               validated proposal -> Confirm button
                               |
               D1 tasks + dedicated Google Calendar

D1 reminder rules -> scheduled Worker -> Telegram notifications
```

The Worker is TypeScript using web-standard APIs. D1 holds tasks, preferences, a bounded conversation history, confirmation proposals, an inbox, and reminders. No frontend, paid queue, or always-on computer is required.

## What is implemented

- Private Telegram user allowlist and webhook secret verification.
- Text, PDF, JPG, PNG, and WebP input (4 MB application limit).
- Gemini structured output with independent runtime validation; documents are treated as data.
- Clarification replies reuse the pending attachment for up to 24 hours. `/reset` clears this context.
- Confirmation before task creation, task edits, natural-language completion, reminders, and preference changes.
- Deterministic task and Google event IDs, durable input deduplication, and resumable imports in batches of three actions.
- Google OAuth with expiring single-use state and AES-GCM encrypted refresh tokens.
- Narrow `calendar.app.created` scope; creates an Assignment Planner calendar on first confirmed import.
- Daily briefing, one-off reminders, overnight quiet hours, Done and Snooze buttons.
- Existing reminders and commands work without Gemini. Local daily AI budget defaults to 15 attempts (UTC reset).
- Date-only deadlines are all-day events. Timed deadlines are one-minute transparent events beginning at the exact deadline; they do not reserve study time.
- Google default reminders are disabled for managed events; reminders are explicitly requested through Telegram.

## Local development

Requires Node.js 24+ and npm. Tests use Node's experimental built-in SQLite module.

```powershell
npm.cmd install
Copy-Item .dev.vars.example .dev.vars
npm.cmd run db:local
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run dev
```

The placeholder D1 UUID supports local development. Replace it with the real database ID before deployment.

`GET /health` returns a minimal health check. With `wrangler dev --test-scheduled`, visit `/__scheduled` to exercise a local scheduled tick. Provider calls need real keys; automated tests mock providers and use a real in-memory SQLite database. No tests call paid services.

Follow [docs/SETUP.md](docs/SETUP.md) to configure the four service accounts and deploy.

## Commands

| Command | Action |
|---|---|
| `/start`, `/help` | Usage and sample requests |
| `/connect` | One-time Google authorization link |
| `/tasks` | Open tasks, calendar links, Done buttons for the first 20 |
| `/pending` | Up to three pending/partially applied proposals |
| `/settings` | Stored preferences and daily briefing rule |
| `/status` | Connection state, daily AI attempts, failed-reminder count |
| `/stop` | Disable briefing and cancel pending reminders |
| `/reset` | Clear recent conversation and pending attachment |

Example requests:

- Upload a syllabus: “Add these assignments for Fall 2026.”
- “Move my History essay deadline to October 12, 2026, at 11:59 p.m.”
- “Remind me October 10, 2026, at 3 p.m. to work on the History essay.”
- “Every day at 9 a.m., show unfinished tasks due within two days.”
- “Don't send reminders between 10 p.m. and 8 a.m.”

## Cost boundaries

Stay on **Workers Free**, **D1 Free**, and a **Gemini project without paid billing**. Use the provided workers.dev hostname; no domain purchase is needed. The app cannot inspect whether you enabled paid billing in a provider console, so account configuration is part of the $0 requirement. It never upgrades a plan or switches to a paid model automatically.

The local AI cap counts attempts, including failed extraction. Gemini may enforce a lower quota. Quota failures pause new AI requests; normal task commands, completion buttons, and saved reminders need no AI. Free services can change their terms and limits; $0 forever or guaranteed uptime cannot be promised.

## Reliability and current limitations

- No live provider integration has been verified until credentials are connected. Local tests verify logic, not OCR/model extraction quality or real OAuth account policy.
- One inbox item and one notification are processed per minute. Larger confirmed imports continue automatically across ticks. Deadlines are scheduled in the user's timezone; cron itself runs in UTC.
- File processing is capped at 4 MB and 30 proposed actions. Split larger documents. Images/PDFs go directly to Gemini; there is no separate OCR service. Test representative files against Workers Free CPU limits before relying on large imports.
- Notifications are **at least once**, not exactly once. A crash after Telegram accepts a message but before D1 records success can produce a duplicate. Retries are bounded to three; `/status` reports failed reminders. Check Calendar for critical deadlines.
- Database tasks are authoritative for completion. Google edits are not synced back; completing a task keeps its calendar event. Updating a deadline does not automatically move earlier reminders.
- Duplicate prevention matches normalized title, due date/time, and timezone. It does not guess that differently worded assignments are identical. Use an explicit update for changed deadlines.
- An import can partially succeed. Applied actions are checkpointed; `/pending` lets you resume. Already-created calendar events are reused on retry. Cancellation only applies before execution starts.
- Briefings include overdue open tasks and tasks through the requested day. Date-only entries are intentionally not assigned an invented hour. Only one daily briefing is supported initially.
- `finish_days_early` is stored for advice; automatic study-block scheduling and habit learning are not implemented. Quiet hours defer delivery until the next allowed scheduler tick.
- Only one connected Google account is supported. Reconnect the same account. Private chat only; no group access, voice messages, account switching, or Chrome extension.
- Recent chat context is capped at 12 records. Completed/failed inbox entries are retained for seven days with their payload erased. Pending proposals include source excerpts and are cleaned up after expiry plus seven days. Task sources remain until manually removed. Original attachment bytes are not stored in D1; a temporary Telegram file reference may be retained for clarification.
- Gemini free-tier content handling differs from paid service terms. Avoid uploading sensitive personal material that you don't want processed under those terms.

## Calendar creation recovery

If the process crashes after Google creates a calendar but before its ID is stored, the app blocks another creation rather than risking multiple calendars. In Google Calendar settings, find **Assignment Planner -> Integrate calendar -> Calendar ID**. Store that exact ID in D1's `settings` table with key `calendar_id`, then delete `calendar_creation_pending`. If no calendar was created, remove only `calendar_creation_pending` and retry. Never reset task IDs or bulk delete calendar events as a recovery shortcut.

## Security

Secrets belong in `.dev.vars` locally and Worker secrets in production; both `.dev.vars` and `.env*` are ignored by git. Refresh tokens are encrypted with `TOKEN_ENCRYPTION_KEY`; keep that key stable and private. Rotating it requires reconnecting Google. Do not put API keys or bot tokens in a video, screenshot, URL shared publicly, or source repository.

The backend checks the allowed Telegram sender and private chat before persisting input. OAuth connection links are short-lived bearer links sent only to that chat. Runtime logs avoid provider responses, file contents, and credentials. Optional Cloudflare observability is disabled by default.
