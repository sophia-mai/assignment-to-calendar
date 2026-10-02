# Setup: personal, free-tier deployment

Complete these steps when ready for live testing. Never paste credentials into chat or commit them to git. The project can be built and tested locally first.

## 1. Telegram

1. In Telegram, open the verified **@BotFather**, send `/newbot`, and choose a name and username.
2. Put its token in `TELEGRAM_BOT_TOKEN` in your local `.dev.vars`.
3. Open the new bot and press **Start**.
4. Before registering a webhook, obtain your numeric user ID from the bot's `getUpdates` response. Use a local script that reads the token from `.dev.vars`, rather than putting the token in browser history or terminal arguments. Inspect `message.from.id`, not a username or bot ID. An optional helper is provided below.
5. Set `ALLOWED_TELEGRAM_USER_ID` to that numeric ID. This app intentionally ignores everyone else.

Run `node scripts/telegram-user-id.mjs` after sending `/start` to print only sender IDs. It will not work if you already configured a webhook.

## 2. Gemini

1. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Choose a project on the **free tier without paid billing**. Do not enable automatic paid fallback or attach billing for this app.
3. Store the key in `GEMINI_API_KEY`.
4. Check that the configured `GEMINI_MODEL` in `wrangler.jsonc` is available on your account's free tier and supports images, PDFs, and structured output. The default is `gemini-3.1-flash-lite`; availability and quotas can change. Change the model configuration if necessary before live testing.
5. Keep `AI_DAILY_LIMIT` at 15 or lower initially. This application cap is additional to Google's limits.

Read [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and [data-use terms](https://ai.google.dev/gemini-api/terms) before sending personal documents.

## 3. Cloudflare

Use a Cloudflare account on **Workers Free**. Do not upgrade to Workers Paid for this project.

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create assignment-to-calendar
npx.cmd wrangler queues create assignment-planner-inbox
```

Copy `wrangler.jsonc` to `wrangler.local.jsonc` (ignored by Git), then put the returned database ID into that local file's D1 binding. Keep binding name `DB`. The shared config intentionally contains a placeholder ID. Each person cloning this project must create their own resources and credentials.

Deploy once to obtain a workers.dev hostname (the bot will not function until secrets are configured):

```powershell
npm.cmd run db:remote -- --config wrangler.local.jsonc
npm.cmd run deploy -- --config wrangler.local.jsonc
```

Set `PUBLIC_BASE_URL` to the returned HTTPS origin, without a trailing slash, in `.dev.vars`.

## 4. Google Calendar OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable **Google Calendar API**.
2. Configure the Google Auth Platform consent screen. For an ordinary personal Google account, choose an external audience and add your own Google email as a test user while developing.
3. In **Data Access → Add or remove scopes**, add these three scopes:
   - `https://www.googleapis.com/auth/calendar.app.created`
   - `https://www.googleapis.com/auth/calendar.events.owned`
   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
4. Create a **Web application** OAuth client.
5. Register the exact redirect URI: `https://YOUR-WORKER.workers.dev/oauth/callback`.
6. Save the client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The app creates a dedicated calendar for new assignments. The additional scopes let it find events, check conflicts, and update notes/locations on calendars you own. `/calendars` controls which owned calendars the application uses; this is an application restriction within the broader OAuth grant. It does not request calendar sharing/deletion administration, Gmail, or Drive access. Enable the regular Google Calendar API; MCP is not needed.

**Upgrading from the original version:** apply migration `0002_calendar_context.sql` (`npm.cmd run db:local` locally and `npm.cmd run db:remote -- --config wrangler.local.jsonc` for a deployed database), deploy the updated Worker, and send `/connect` again to grant the new scopes. Console scope changes alone do not update an existing token. Then run `/calendars`; your primary calendar is selected by default. Select the planner calendar too if you want to search or edit its events through the new features.

Google OAuth projects left in Testing commonly issue refresh tokens that expire after seven days for Calendar scopes. This is a testing configuration issue, not an API charge; reconnect with `/connect` when required. Before relying on ongoing reminders/imports, review Google's personal-use/production publishing requirements for your account and requested scope. School Workspace admins may restrict consent. Do not assume public OAuth verification has been completed by this code.

## 5. Generate secrets

Generate these locally and save them securely. Avoid filming the terminal while doing this.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use the first output for `TOKEN_ENCRYPTION_KEY`, the second for `TELEGRAM_WEBHOOK_SECRET`. Keep the encryption key stable across deployments.

## 6. Upload Worker secrets

Each command prompts for the value, avoiding secrets in command arguments:

```powershell
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.local.jsonc
npx.cmd wrangler secret put TELEGRAM_WEBHOOK_SECRET --config wrangler.local.jsonc
npx.cmd wrangler secret put ALLOWED_TELEGRAM_USER_ID --config wrangler.local.jsonc
npx.cmd wrangler secret put PUBLIC_BASE_URL --config wrangler.local.jsonc
npx.cmd wrangler secret put GEMINI_API_KEY --config wrangler.local.jsonc
npx.cmd wrangler secret put GOOGLE_CLIENT_ID --config wrangler.local.jsonc
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.local.jsonc
npx.cmd wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.local.jsonc
```

Ensure the local `.dev.vars` values match production for webhook registration.

```powershell
npm.cmd run telegram:register
```

The configured queue starts processing incoming interactions immediately. Keep consumer concurrency at one so conversation and calendar selections remain ordered. The cron handles scheduled reminders and recovery once per minute. New trigger changes can take several minutes to propagate. No custom domain is necessary.

## 7. Live acceptance check

Timezone controls: send `/timezone` to see your default, or `/timezone Eastern`, `/timezone Pacific`, or `/timezone Europe/London` to change it after confirming. Use region names instead of ambiguous abbreviations such as CST. Dates show EST/EDT (or the appropriate local label) automatically. Existing schedules are not moved when the default changes.

1. Send `/start`; it should respond without waiting for a minute cron tick. Provider/network latency can still take several seconds.
2. Send `/connect`, open the link, and authorize the correct Google account.
3. Send “Add Test assignment due December 15, 2026, at 5 p.m.” Adjust the date if it is now in the past.
4. Confirm the proposal. Verify the title, date, timezone, and link in the dedicated calendar.
5. Repeat the same request and confirm; verify there is still one event.
6. Send a small redacted assignment screenshot, then a syllabus PDF. Verify extraction against the originals; the mocked tests cannot establish model accuracy.
7. Ask for a task-linked reminder a few minutes ahead; confirm and verify delivery.
8. Test **Snooze**, then **Done**. Confirm linked reminders are cancelled.
9. Configure a briefing and quiet hours. Verify the schedule in `/settings`.
10. Set the local daily AI limit to 0 in a test deployment; verify `/tasks` and scheduled reminders still function without AI.
11. Run `/calendars` and select the calendars to check. Create an event manually in a selected calendar and ask the bot to find it.
12. Ask whether you are free during that event and immediately after it ends. Verify the first conflicts and the adjacent interval does not.
13. Ask to append a note and set its location. Verify the confirmation shows the exact event, full resulting description, and old/new location. Confirm and verify the event time and unrelated details stay intact.
14. Request another edit, modify the event manually before confirming, and verify the stale proposal is rejected.
15. Test ambiguous titles and a recurring event. Verify the bot asks which match and whether the edit applies to one occurrence or the entire series.
16. Try importing an assignment with the same title/date as your manually created event. Verify it asks about the possible duplicate instead of adding another event.

If an import partially fails, use `/pending` to resume. Do not resend repeatedly before checking for existing events. See README for calendar-creation recovery and notification delivery limitations.

## Upgrade: faster responses and timed sessions

For an existing deployment, create the queue once, apply migration `0003_calendar_toggle_receipt.sql`, and redeploy:

```powershell
npx.cmd wrangler queues create assignment-planner-inbox
npm.cmd run db:remote -- --config wrangler.local.jsonc
npm.cmd run deploy -- --config wrangler.local.jsonc
```

Skip queue creation if it already exists. Stay on Workers Free; no paid upgrade is needed for [Queues within its free allowance](https://developers.cloudflare.com/queues/platform/pricing/). No new Google scopes or webhook registration are needed for this upgrade.

Send `/calendars` for a fresh menu. Select more than five calendars (up to 20), and verify each tap changes that same message. Old menus remain in chat. Send “Schedule a study group tomorrow from 1 p.m. to 2 p.m.” Verify the immediate receipt, then the dated preview or a conflict/clarification reply. Confirm only after reviewing it, and verify a full one-hour busy event in Assignment Planner. Repeat the request to verify no duplicate. Create a conflicting event after a preview and verify confirmation asks for another time. For already-failed old requests, resend with an explicit date; they are not automatically replayed.

## Live edit/delete acceptance check

Use a disposable event you create yourself. Ask the bot to rename it, verify the exact title/date/calendar preview, and confirm. Ask to move it to a free interval, then repeat with a conflicting interval and verify the latter is blocked at confirmation. Ask to delete it and test Cancel first, then request again and confirm deletion. Modify an event manually after its preview and verify the bot refuses the stale change. For recurring events, confirm that it asks one occurrence versus the entire series. Renaming/deleting a whole series is supported; moving a whole series or an all-day event is not. Standalone reminders keep their original schedule.

## Upgrade: AI retries and diagnostics

Apply migration `0004_request_diagnostics.sql` using `npm run db:remote -- --config wrangler.local.jsonc` before deploying. The configured model is now `gemini-3.1-flash-lite`; update your ignored local config too. Temporary AI failures retry through the existing queue at most three times (one and two minute delays), counting every attempt against the daily AI cap. Quota and access errors stop immediately. `/diagnostics` displays recent failures for up to seven days without making AI calls; it never displays API keys or raw provider responses. Calendar confirmations include returned event links when available. No billing upgrade or automatic paid fallback is configured.

Temporary AI errors (HTTP 5xx or network timeout) switch subsequent queue attempts to `GEMINI_FALLBACK_MODEL` (`gemini-3.5-flash-lite`). The primary remains `gemini-3.1-flash-lite`. The three-attempt limit is shared across both models, and each attempt counts against the same daily cap. Quota/access errors, invalid output, and Calendar failures do not trigger model switching. Configure only models available on your account's free tier; this setting does not change billing. Existing failed requests must be resent.

## Upgrade: clarification context and attempt history

Apply `0005_ai_attempts.sql` before deploying. `/diagnostics` shows the last ten model attempts with request ID, model, elapsed time, and outcome; records expire after seven days. Attempt records contain no prompts, API keys, or raw responses. Pending text requests now use the same 24-hour context as uploads, retain up to six follow-ups, and clear after a successful preview/read or `/reset`. AI-only replies are limited to clarification questions; completed-action confirmations come from application handlers. Retry limits and the daily cap are unchanged.
