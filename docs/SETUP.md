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
4. Check that the configured `GEMINI_MODEL` in `wrangler.jsonc` is available on your account's free tier and supports images, PDFs, and structured output. The initial default is `gemini-2.5-flash`; availability and quotas can change. Change the model configuration if necessary before live testing.
5. Keep `AI_DAILY_LIMIT` at 15 or lower initially. This application cap is additional to Google's limits.

Read [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing) and [data-use terms](https://ai.google.dev/gemini-api/terms) before sending personal documents.

## 3. Cloudflare

Use a Cloudflare account on **Workers Free**. Do not upgrade to Workers Paid for this project.

```powershell
npx.cmd wrangler login
npx.cmd wrangler d1 create assignment-to-calendar
```

Copy the returned database ID into the D1 binding in `wrangler.jsonc`. Keep binding name `DB`.

Deploy once to obtain a workers.dev hostname (the bot will not function until secrets are configured):

```powershell
npm.cmd run db:remote
npm.cmd run deploy
```

Set `PUBLIC_BASE_URL` to the returned HTTPS origin, without a trailing slash, in `.dev.vars`.

## 4. Google Calendar OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create/select a project and enable **Google Calendar API**.
2. Configure the Google Auth Platform consent screen. For an ordinary personal Google account, choose an external audience and add your own Google email as a test user while developing.
3. Request only `https://www.googleapis.com/auth/calendar.app.created`.
4. Create a **Web application** OAuth client.
5. Register the exact redirect URI: `https://YOUR-WORKER.workers.dev/oauth/callback`.
6. Save the client ID and secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The app creates a dedicated calendar and cannot edit unrelated calendars with this scope. It does not need access to Gmail or Drive.

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
npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN
npx.cmd wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx.cmd wrangler secret put ALLOWED_TELEGRAM_USER_ID
npx.cmd wrangler secret put PUBLIC_BASE_URL
npx.cmd wrangler secret put GEMINI_API_KEY
npx.cmd wrangler secret put GOOGLE_CLIENT_ID
npx.cmd wrangler secret put GOOGLE_CLIENT_SECRET
npx.cmd wrangler secret put TOKEN_ENCRYPTION_KEY
```

Ensure the local `.dev.vars` values match production for webhook registration.

```powershell
npm.cmd run telegram:register
```

Cron triggers are configured once per minute. New trigger changes can take several minutes to propagate. No custom domain is necessary.

## 7. Live acceptance check

1. Send `/start`; allow a minute for processing.
2. Send `/connect`, open the link, and authorize the correct Google account.
3. Send “Add Test assignment due December 15, 2026, at 5 p.m.” Adjust the date if it is now in the past.
4. Confirm the proposal. Verify the title, date, timezone, and link in the dedicated calendar.
5. Repeat the same request and confirm; verify there is still one event.
6. Send a small redacted assignment screenshot, then a syllabus PDF. Verify extraction against the originals; the mocked tests cannot establish model accuracy.
7. Ask for a task-linked reminder a few minutes ahead; confirm and verify delivery.
8. Test **Snooze**, then **Done**. Confirm linked reminders are cancelled.
9. Configure a briefing and quiet hours. Verify the schedule in `/settings`.
10. Set the local daily AI limit to 0 in a test deployment; verify `/tasks` and scheduled reminders still function without AI.

If an import partially fails, use `/pending` to resume. Do not resend repeatedly before checking for existing events. See README for calendar-creation recovery and notification delivery limitations.
