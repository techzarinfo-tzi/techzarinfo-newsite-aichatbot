import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { getSystemPrompt } from "./systemPrompt.js";
import { saveExchange } from "./chatLog.js";
import { getQuota, refundQuestion, takeQuestion } from "./quota.js";

const MODEL = "claude-opus-5";
const MAX_MESSAGES = 20; // conversation turns sent to the model (older ones are dropped)
const MAX_CHARS = 2000; // per visitor message
const MAX_BODY_BYTES = 64 * 1024;
const FALLBACK_REPLY =
  "Sorry, I can't help with that one. For anything else, please reach our team through the [contact page](/contact).";

// Simple per-IP limiter held in this process's memory. If you run several instances behind a
// load balancer, each counts separately; swap in a shared store (e.g. Redis) if abused.
const WINDOW_MS = 10 * 60 * 1000;
const WINDOW_LIMIT = 30;
const hits = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) {
    for (const [key, times] of hits) if (now - times[times.length - 1] > WINDOW_MS) hits.delete(key);
  }
  return recent.length > WINDOW_LIMIT;
}

// Accept only a clean user/assistant transcript that ends on the visitor's new message.
function cleanMessages(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const messages = input.slice(-MAX_MESSAGES);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length) return null;

  const out = [];
  for (const [i, m] of messages.entries()) {
    const role = i % 2 === 0 ? "user" : "assistant";
    if (m?.role !== role || typeof m.content !== "string") return null;
    const content = m.content.trim().slice(0, MAX_CHARS);
    if (!content) return null;
    out.push({ role, content });
  }
  return out[out.length - 1].role === "user" ? out : null;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function clientIp(req) {
  // Only trust X-Forwarded-For behind a reverse proxy (nginx, a load balancer), otherwise
  // visitors could fake it to dodge the rate limit.
  if (process.env.TRUST_PROXY === "true") {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

let client;

// A UUID from the widget (visitor or conversation ID), lowercased, or null.
function cleanId(value) {
  return UUID_RE.test(value) ? value.toLowerCase() : null;
}

function quotaHeaders({ limit, remaining, resetAt }) {
  return {
    "X-Chat-Limit": String(limit),
    "X-Chat-Remaining": String(remaining),
    ...(resetAt ? { "X-Chat-Reset-At": resetAt.toISOString() } : {}),
  };
}

// GET /api/chat/quota?visitorId=... -> { limit, remaining, resetAt } (resetAt only once none remain)
export async function handleQuota(req, res) {
  const { searchParams } = new URL(req.url, "http://localhost");
  const quota = await getQuota({ visitorId: cleanId(searchParams.get("visitorId")), ip: clientIp(req) });
  res.setHeader("Cache-Control", "no-store");
  return sendJson(res, 200, quota);
}

// POST /api/chat: { visitorId, conversationId, messages: [{ role, content }, ...] } -> streamed
// plain-text reply. conversationId (a UUID the widget makes per chat) groups the saved questions
// and answers; visitorId (a UUID kept in the visitor's browser) ties one person's chats together
// and counts against their daily question limit (see quota.js).
export async function handleChat(req, res) {
  if (rateLimited(clientIp(req))) {
    return sendJson(res, 429, {
      error: "You're sending messages too quickly. Please wait a few minutes and try again.",
    });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return sendJson(res, 400, { error: "Invalid request." });
  }
  const messages = cleanMessages(body?.messages);
  if (!messages) return sendJson(res, 400, { error: "Invalid conversation." });
  const conversationId = cleanId(body.conversationId) ?? randomUUID();
  const visitorId = cleanId(body.visitorId);
  const ip = clientIp(req);
  const who = { visitorId, ip };

  let systemPrompt;
  try {
    systemPrompt = getSystemPrompt();
    client ??= new Anthropic();
  } catch (err) {
    console.error("[chat] not configured:", err.message);
    return sendJson(res, 503, { error: "The assistant is not available right now." });
  }

  const quota = await takeQuestion(who);
  if (!quota.allowed) {
    res.writeHead(429, { "Content-Type": "application/json; charset=utf-8", ...quotaHeaders(quota) });
    return res.end(
      JSON.stringify({
        error: `You've used all ${quota.limit} questions for today. Please come back later, or reach our team through the [contact page](/contact).`,
        code: "daily_limit",
        limit: quota.limit,
        remaining: quota.remaining,
        resetAt: quota.resetAt,
      })
    );
  }
  const askedAt = new Date();

  // Stop generating (and paying for) tokens if the visitor closes the chat mid-answer.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const stream = client.beta.messages.stream(
    {
      model: MODEL,
      max_tokens: 2048,
      output_config: { effort: "low" }, // short, fast chat answers
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines, retry server-side on Anthropic's recommended model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: systemPrompt,
      messages,
    },
    { signal: abort.signal }
  );

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no", // stop nginx from buffering the stream
    ...quotaHeaders(quota),
  });

  // Everything the visitor is shown, so the saved answer matches what they saw.
  let answer = "";
  let status = "answered";
  const write = (text) => {
    res.write(text);
    answer += text;
  };

  try {
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        write(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal" && !answer) {
      write(FALLBACK_REPLY);
      status = "refused";
    }
  } catch (err) {
    if (abort.signal.aborted) {
      status = "stopped";
    } else {
      console.error("[chat] stream failed:", err);
      status = answer ? "cut_off" : "failed";
      write(
        answer
          ? "\n\n(Sorry, my answer was cut off. Please try again.)"
          : "Sorry, I'm having trouble answering right now. Please try again in a moment, or reach us through the [contact page](/contact)."
      );
    }
  } finally {
    res.end();
  }

  // A question the AI never answered doesn't use up the visitor's allowance.
  if (status === "failed") {
    refundQuestion(who).catch((err) => console.error("[chat] could not refund question:", err.message));
  }

  const question = messages[messages.length - 1].content;
  saveExchange({ conversationId, visitorId, ip, question, answer, status, askedAt }).catch((err) =>
    console.error("[chat] could not save conversation:", err.message)
  );
}
