# Assignment Planner

A single-user Telegram assistant that turns text, screenshots, and syllabus PDFs into reviewed Google Calendar deadlines, tracks completion, and sends scheduled Telegram reminders. Designed for free service tiers; no paid fallback is implemented.

## Architecture

```text
Telegram webhook -> authenticated durable D1 inbox
                               |
                  Cloudflare Queue (immediate consumer)
                               |
            commands OR Gemini structured extraction
                               |
               validated proposal -> Confirm button
                               |
               D1 tasks + dedicated Google Calendar

D1 reminder rules -> scheduled Worker -> Telegram notifications
```

The Worker is TypeScript using web-standard APIs. D1 holds tasks, preferences, a bounded conversation history, confirmation proposals, an inbox, and reminders. Cloudflare Queues wakes the consumer immediately; the minute cron handles reminders and recovers missed wakeups. No frontend or always-on computer is required.

## What is implemented

- Private Telegram user allowlist and webhook secret verification.
- Text, PDF, JPG, PNG, and WebP input (4 MB application limit).
- Gemini structured output with independent runtime validation; documents are treated as data.
- Clarification replies reuse the pending attachment for up to 24 hours. `/reset` clears this context.
- Confirmation before task creation, task edits, natural-language completion, reminders, and preference changes.
- Deterministic task and Google event IDs, durable input deduplication, and resumable imports in batches of three actions.
- Google OAuth with expiring single-use state and AES-GCM encrypted refresh tokens.
- OAuth scopes: `calendar.app.created`, `calendar.events.owned`, and `calendar.calendarlist.readonly`. Creates an Assignment Planner calendar on first confirmed import; selected owned calendars can also be searched and edited.
- `/calendars` selects up to 20 owned calendars (primary is the default). Live searches, conflict checks, and duplicate preflight use that selection. Buttons update the existing menu; a five-minute list cache makes repeated taps fast. Live reads always revalidate access.
- Existing events can be renamed, rescheduled, or deleted after an exact preview. Planner calendar events are included automatically for those operations; other events must be on selected owned calendars. Deletion has a distinct Confirm deletion button. Timed single events and individual recurring occurrences can move, with a live conflict check at confirmation; whole-series and all-day moves are not supported.
- Existing event notes and locations can be updated after a concrete preview. Descriptions are appended, other fields preserved, and ETags prevent overwriting changes made after review. Recurring events require occurrence/series selection.
- Daily briefing, one-off reminders, overnight quiet hours, Done and Snooze buttons.
- Dates in replies use weekdays, month names, ordinal days, and 12-hour times with date-specific timezone labels (EST/EDT, for example). All-day dates remain all-day; multi-day events show the last included day.
- `/timezone` shows the saved default and current local time. `/timezone Eastern`, `/timezone Pacific`, or `/timezone Europe/London` proposes a change for confirmation without using AI. Natural language such as “Change my timezone to Eastern Time” also works. The saved default controls future requests, task displays, and quiet hours. Existing events, reminders, daily briefings, and pending proposals retain their scheduled times; change those explicitly when needed.
- Existing reminders and commands work without Gemini. Local daily AI budget defaults to 15 attempts (UTC reset).
- Date-only deadlines are all-day events. Timed deadlines are one-minute transparent events beginning at the exact deadline; they do not reserve study time.
- Explicitly requested meetings and study sessions reserve their full start/end interval in Assignment Planner after confirmation. One session per request; conflicts and duplicates are checked before preview and at confirmation, including the destination calendar. Conflicting sessions ask for another time. Sessions are not task-completion records, and no guests are invited.
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

The placeholder D1 UUID supports local development. For deployment, copy `wrangler.jsonc` to the ignored `wrangler.local.jsonc` and put your own database ID there. Use `npm run deploy -- --config wrangler.local.jsonc` and `npm run db:remote -- --config wrangler.local.jsonc`. Keep the shared config generic; everyone cloning the project supplies their own accounts and credentials. Apply future shared configuration changes to your local copy as needed.

`GET /health` returns a minimal health check. With `wrangler dev --test-scheduled`, visit `/__scheduled` to exercise a local scheduled tick. Provider calls need real keys; automated tests mock providers and use a real in-memory SQLite database. No tests call paid services.

Follow [docs/SETUP.md](docs/SETUP.md) to configure the four service accounts and deploy.

## Commands

| Command | Action |
|---|---|
| `/start`, `/help` | Usage and sample requests |
| `/connect` | One-time Google authorization link |
| `/calendars` | Select/deselect owned calendars for searches and existing-event edits |
| `/reminders` | Upcoming reminders sent in this Telegram chat; no calendar event is created |
| `/tasks` | Open tasks, calendar links, Done buttons for the first 20 |
| `/pending` | Up to three pending/partially applied proposals |
| `/settings` | Stored preferences and daily briefing rule |
| `/diagnostics` | Recent failure reasons, processing step, retry attempts, and recorded changes |
| `/status` | Connection state, daily AI attempts, failed-reminder count |
| `/stop` | Disable briefing and cancel pending reminders |
| `/reset` | Clear recent conversation and pending attachment |

Example requests:

- Upload a syllabus: “Add these assignments for Fall 2026.”
- “Move my History essay deadline to October 12, 2026, at 11:59 p.m.”
- “Remind me October 10, 2026, at 3 p.m. to work on the History essay.”
- “Every day at 9 a.m., show unfinished tasks due within two days.”
- “Don't send reminders between 10 p.m. and 8 a.m.”
- “Am I free October 8, 2026, from 3 to 4 p.m.?”
- “Find my biology exam on October 8, 2026.”
- “Add bring a calculator to the description of that exam and set its location to Room 204.”
- “Change the location for this occurrence of my Friday study group.”

## Cost boundaries

Stay on **Workers Free**, **D1 Free**, and a **Gemini project without paid billing**. Use the provided workers.dev hostname; no domain purchase is needed. The app cannot inspect whether you enabled paid billing in a provider console, so account configuration is part of the $0 requirement. It never upgrades a plan or switches to a paid model automatically.

The local AI cap counts attempts, including failed extraction. Gemini may enforce a lower quota. Quota failures pause new AI requests; normal task commands, completion buttons, and saved reminders need no AI. Free services can change their terms and limits; $0 forever or guaranteed uptime cannot be promised.

## Reliability and current limitations

- No live provider integration has been verified until credentials are connected. Local tests verify logic, not OCR/model extraction quality or real OAuth account policy.
- Incoming interactions run through an immediate queue, one job at a time. Larger confirmed imports continue automatically in separate queue invocations. Scheduled notifications still run once per minute. Deadlines use the user's timezone; cron itself runs in UTC.
- File processing is capped at 4 MB and 30 proposed actions. Split larger documents. Images/PDFs go directly to Gemini; there is no separate OCR service. Test representative files against Workers Free CPU limits before relying on large imports.
- Notifications are **at least once**, not exactly once. A crash after Telegram accepts a message but before D1 records success can produce a duplicate. Retries are bounded to three; `/status` reports failed reminders. Check Calendar for critical deadlines.
- Database tasks are authoritative for completion. Google edits are not synced back; completing a task keeps its calendar event. Updating a deadline does not automatically move earlier reminders.
- Duplicate prevention uses stable IDs for bot-created tasks and a live same-day title-similarity check on selected calendars before preview and again before creation. Possible matches stop the import for clarification; they are never automatically merged or overwritten. This is heuristic, not semantic certainty. Existing external events are not automatically converted to local tasks.
- An import can partially succeed. Applied actions are checkpointed; `/pending` lets you resume. Already-created calendar events are reused on retry. Cancellation only applies before execution starts.
- Briefings include overdue open tasks and tasks through the requested day. Date-only entries are intentionally not assigned an invented hour. Only one daily briefing is supported initially.
- `finish_days_early` is stored for advice; automatic study-block suggestions and habit learning are not implemented; explicitly requested timed sessions are supported. Quiet hours defer delivery until the next allowed scheduler tick.
- Only one connected Google account is supported. Reconnect the same account. Private chat only; no group access, voice messages, account switching, or Chrome extension.
- Existing-event edits support appending notes and setting a non-empty location, one event per request, separately from new-task imports. The note/location action does not replace notes or change guests. Separate rename, reschedule, and delete actions support other event changes. Events organized by someone else are rejected. For events with guests, the preview discloses that Google sends update notifications.
- Conflict checks use live events, ignore cancelled/transparent/self-declined events, handle all-day events in their calendar timezone, and treat adjacent intervals as non-overlapping. They check only selected owned calendars. Free/busy-only shared calendars are not supported. A clear result is a snapshot, not a reservation.
- Calendar lookups expand recurring events, handle pagination, and fail explicitly if results exceed bounded limits (three pages per calendar and 24 event-list requests per scan); they never report incomplete results as clear. Searches are limited to one year and availability intervals to seven days. One live read per chat request. Cached match references expire after 30 minutes; `/reset` clears them.
- Event edits store the reviewed version and use conditional PATCH. A receipt in private event metadata prevents repeating an append after a lost response. Later task deadline changes preserve these notes and locations.
- Recent chat context is capped at 12 records. Completed/failed inbox entries are retained for seven days with their payload erased. Pending proposals include source excerpts and are cleaned up after expiry plus seven days. Task sources remain until manually removed. Original attachment bytes are not stored in D1; a temporary Telegram file reference may be retained for clarification.
- Gemini free-tier content handling differs from paid service terms. Avoid uploading sensitive personal material that you don't want processed under those terms.

## Calendar creation recovery

If the process crashes after Google creates a calendar but before its ID is stored, the app blocks another creation rather than risking multiple calendars. In Google Calendar settings, find **Assignment Planner -> Integrate calendar -> Calendar ID**. Store that exact ID in D1's `settings` table with key `calendar_id`, then delete `calendar_creation_pending`. If no calendar was created, remove only `calendar_creation_pending` and retry. Never reset task IDs or bulk delete calendar events as a recovery shortcut.

## Security

Secrets belong in `.dev.vars` locally and Worker secrets in production; both `.dev.vars` and `.env*` are ignored by git. Refresh tokens are encrypted with `TOKEN_ENCRYPTION_KEY`; keep that key stable and private. Rotating it requires reconnecting Google. Do not put API keys or bot tokens in a video, screenshot, URL shared publicly, or source repository.

The backend checks the allowed Telegram sender and private chat before persisting input. OAuth connection links are short-lived bearer links sent only to that chat. Runtime logs avoid provider responses, file contents, and credentials. Optional Cloudflare observability is disabled by default.

Git also ignores local deployment configuration, common credential/key files, local databases, and `private/`, `backups/`, and `exports/`. Put personal screenshots, syllabuses, raw SQL exports, and other private material in those ignored directories. Keep schema migrations in `migrations/` tracked. Ignore rules do not remove files or author email addresses from existing commits; review Git history before publishing and never force-add secrets. If a credential was committed, revoke/rotate it as well as removing it from history.

Cloning this repository does not grant access to the original deployment or its API keys. A public Worker endpoint can still receive unwanted traffic; ignore rules are not rate limiting or billing controls. Keep the webhook secret and Telegram allowlist configured, keep the AI daily cap, and use the free-tier account settings described above.

## Immediate processing and queue recovery

Create `assignment-planner-inbox` once with `npx.cmd wrangler queues create assignment-planner-inbox`, apply migrations, and deploy. Cloudflare Queues is available on [Workers Free](https://developers.cloudflare.com/queues/platform/pricing/) with 10,000 operations/day; remain on the Free plan. Queue wakeups contain no chat content. The consumer processes one D1 job at a time (`max_concurrency: 1`); D1 update IDs deduplicate deliveries. A failed queue handoff returns an HTTP error so Telegram can retry. The minute cron recovers missed wakeups and expired job leases. Large confirmations enqueue their next batch after one second rather than waiting a minute. Provider failures still use bounded delayed retries. Normal messages get a webhook receipt; buttons are acknowledged immediately. Telegram webhook-response messages are best effort and their delivery cannot be verified from the response.

Calendar selection and its inbox receipt are saved together. A failed menu edit can therefore retry without toggling the selection a second time. Calendar reads run up to four at a time, with a total request budget to protect free hosting limits. An incomplete scan fails explicitly.

## Editing and removing events in chat

Try “Rename my study group tomorrow to Study chemistry”, “Move my study group tomorrow to 4–5 p.m.”, or “Delete my study group tomorrow.” The bot searches by the old title/date, shows the exact calendar and event, and asks when several match. Each rename/move/delete request handles one event. Recurring events require explicit occurrence or series scope. Renaming and deleting an entire series is supported; moving a series or “this and following” is not.

Mutations use the reviewed ETag with If-Match; changes made after review require a fresh preview. PATCH receipts prevent duplicate retries, and missing/cancelled events make deletion retries harmless. Guest notifications are disclosed in the preview. Rename keeps local assignment titles in sync; deletion cancels matching local assignments and linked pending reminders. Standalone session reminders are separate and are not cancelled or moved automatically. Task deadline changes continue to use the task-update action. No new OAuth scope or database migration is needed.

## Clarification for uploads

When a poster contains multiple possible dates (such as an event and its submission deadline), the bot asks which item to add and requests missing year/time details. It asks at most two focused questions at a time. Invalid structured output safely becomes a clarification with no executable actions, rather than blaming image quality. A question accompanied by tentative model actions discards those actions. This recovery uses no additional model call.

Telegram attachment references and original caption/date are retained for up to 24 hours after the latest interaction, including provider quota errors/timeouts, so the user can answer without re-uploading. Original file bytes are not saved. New uploads replace that context, completed interpretation clears it, and `/reset` clears it manually. Provider quota/connection errors remain explicit errors rather than misleading clarification questions.

## Find the first available time

Ask “Find the first free 30 minutes today to review my homework.” The bot scans selected calendars plus Assignment Planner and previews the earliest future gap. Omitted hours default to 9am–9pm in your timezone; specify a different window if desired. Searches cover at most seven dates and durations up to 12 hours. Busy all-day events block availability; transparent or declined events do not. Confirm the concrete preview to create the event; conflicts are checked again then. If no gap fits, nothing is created. Overnight daily windows must be split into separate searches.

## Choose an event calendar

Ask “Schedule the workshop on October 5 from 7pm to 9pm in my JHU Events calendar.” New timed events and first-available-slot searches accept an explicit owned calendar name. The preview displays the resolved destination; confirmation checks that it is still accessible and writes to that same calendar. Missing or ambiguous names require clarification and never fall back to primary. Without a destination, events still go into Assignment Planner. This does not change `/calendars` conflict-selection settings. Assignment deadlines still use Assignment Planner. Up to ten events can share a request and preview. Conflicts still block creation. Shared calendars with writer-only access are not supported by the current owned-event permissions.

## Multiple events from one screenshot

Send one image with “Add both events to JHU Events.” One model response can extract up to ten separate events; review all dates, times, locations, and destinations before confirming once. The bot scans availability for the combined window (at most one year), then checks and creates each event in a separate queue invocation. Each successful event is checkpointed and reported with its link. If processing stops, `/pending` resumes the remaining changes without recreating saved events. Overlaps between proposed events or existing busy events still block scheduling; conflict overrides are not implemented.
