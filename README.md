# AIChatbot

The AI chat service for the Techzarinfo website. It's a standalone Node.js server (default port **4000**) that answers visitor questions about TechZarInfo using Claude, and it only uses the company information in `knowledge/chatbot-knowledge.txt`.

It's separate from the website. The website (`../frontend`, port 3000) talks to it only through the HTTP API below.

```
Techzarinfo-Newsite/
├── AIChatbot/                      ← this service
│   ├── package.json
│   ├── .env                        ← API key + settings (not committed)
│   ├── .env.example
│   ├── knowledge/
│   │   └── chatbot-knowledge.txt   ← company information the bot answers from (edit this)
│   └── server/
│       ├── index.js                ← HTTP server: port, CORS, routes
│       ├── chatHandler.js          ← POST /api/chat: validation, rate limit, streams Claude's reply
│       ├── quota.js                ← daily question limit per visitor (no login)
│       ├── chatLog.js              ← saves every question and answer for the admin panel
│       ├── db.js                   ← shared MongoDB connection
│       └── systemPrompt.js         ← bot rules (scope, language, accuracy) + knowledge loading
└── frontend/                       ← the website
    └── src/components/chatbot/
        ├── ChatWidget.js           ← chat button + panel; calls this service's API
        └── ChatWidget.css
```

## Running locally

**Terminal 1: this service (port 4000)**
```bash
cd d:\Jo\Techzarinfo-Newsite\AIChatbot
npm install        # first time only
npm run dev        # restarts automatically when server files change
```

**Terminal 2: the website (port 3000)**
```bash
cd d:\Jo\Techzarinfo-Newsite\frontend
npm run dev
```

Open http://localhost:3000 and click the chat button. To check this service on its own, open http://localhost:4000/health.

## API

### `POST /api/chat`

Request body (JSON): the conversation so far, oldest message first and ending with the visitor's new question.

```json
{
  "visitorId": "3f0c2b1e-8a4d-4c7e-9b1a-2d5e6f7a8b9c",
  "conversationId": "b8d1e2f3-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  "messages": [
    { "role": "user", "content": "Do you build mobile apps?" },
    { "role": "assistant", "content": "Yes, Android and iOS apps." },
    { "role": "user", "content": "Where are you based?" }
  ]
}
```

`visitorId` is an anonymous UUID the widget keeps in the visitor's browser; `conversationId` is a UUID per chat. Both are optional but the widget always sends them.

Response: `200` with the reply streamed as plain text (`text/plain; charset=utf-8`). Read the body as a stream to show the answer as it's being written. The reply may contain `**bold**`, `- ` bullet lists and `[text](/path)` links.

Errors come back as JSON `{ "error": "message for the visitor" }`:
- `400`: invalid request or conversation
- `429`: rate limit hit (30 messages per 10 minutes per IP), or the daily limit is used up. The daily limit response also has `"code": "daily_limit"` and `resetAt` (when the visitor can chat again)
- `503`: service not configured (missing knowledge file)

Every response carries `X-Chat-Limit`, `X-Chat-Remaining` and, once nothing remains, `X-Chat-Reset-At`.

The route limits the conversation to the last 20 messages and caps each message at 2,000 characters.

### `GET /api/chat/quota?visitorId=<uuid>`

The visitor's allowance without using any: `{ "limit": 7, "remaining": 4, "resetAt": null }`. `resetAt` is set only when `remaining` is 0.

### Daily limit

Each visitor may ask `CHAT_DAILY_LIMIT` (default 7) questions. Their 24-hour window starts with their first question; the question that uses up the allowance restarts it, so they wait a full 24 hours from hitting the limit. There's no login: a visitor is counted both by the anonymous ID in their browser and by their IP address, and refused when either is used up, so clearing browser data doesn't reset it. A question that gets no answer at all (the AI service failed) is given back. Counts are kept in MongoDB (collection `chatquotas`, cleaned up automatically) so they survive restarts.

### `GET /health`

Returns `{"ok":true,"apiKey":true}`. `apiKey` shows whether `ANTHROPIC_API_KEY` is set.

### CORS

Browsers can only call the API from origins listed in `ALLOWED_ORIGINS`.

## Configuration: `.env`

Copy `.env.example` to `.env`. Restart the server after changes.

| Setting | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key. |
| `PORT` | Port to listen on (default 4000). |
| `ALLOWED_ORIGINS` | Comma-separated website origins allowed to call the API, e.g. `http://localhost:3000,https://www.techzarinfo.com`. |
| `TRUST_PROXY` | Set to `true` only behind nginx or a load balancer, so rate limiting sees real visitor IPs. |
| `MONGO_URI` | MongoDB where every question and answer is saved (collection `chatconversations`), for the admin panel, along with daily limit counts (`chatquotas`). Use the same database as the backend. Leave empty to not save anything (limits are then counted in memory and reset on restart). |
| `CHAT_DAILY_LIMIT` | Questions per visitor per 24 hours (default 7). |
| `CHAT_IP_DAILY_LIMIT` | Questions per IP address per 24 hours (default: same as `CHAT_DAILY_LIMIT`). Raise it if people sharing one office network get blocked together. |

The website points at this service with `NEXT_PUBLIC_CHATBOT_API_URL` in `frontend/.env` (default `http://localhost:4000`). That value is built into the site, so rebuild the site after changing it.

## Updating what the bot knows

Edit `knowledge/chatbot-knowledge.txt` in plain text: sentences, headings and `- ` bullet lists all work. The server re-reads the file whenever it changes, so there's no restart needed, even in production.

The server skips a few things so the file can hold unfinished drafts:
- an editor-notes block at the very top, between `=====` lines,
- empty fields like `- Email:` with nothing after them,
- `(Add ...)` placeholder notes.

## Bot behaviour

The rules live in `server/systemPrompt.js`: answer only what's asked, reply in the visitor's language (English, Tamil or Tanglish), stay on TechZarInfo topics, and never make up information. Other settings are in `server/chatHandler.js`:

- `MODEL`: the Claude model (default `claude-opus-5`).
- `output_config.effort`: `"low"` for the fastest replies; `"medium"` follows the rules more strictly but is slower.
- `MAX_MESSAGES` / `MAX_CHARS`: conversation length and message size limits.
- `WINDOW_LIMIT` / `WINDOW_MS`: rate limit per visitor IP, counted in this process's memory.

## Deploying

1. Copy this folder to any server with Node.js 22+ and run `npm install --omit=dev`, then `npm start`. Keep it running with pm2, systemd or your host's process manager.
2. Give it a public **HTTPS** address, e.g. `https://chat-api.techzarinfo.com`. Browsers block calls from an HTTPS site to a plain-HTTP server.
3. Set `ALLOWED_ORIGINS` to include `https://www.techzarinfo.com`.
4. In the website's `.env`, set `NEXT_PUBLIC_CHATBOT_API_URL` to this service's address, then rebuild and deploy the website.
