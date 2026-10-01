import http from "node:http";
import { handleChat, handleQuota } from "./chatHandler.js";

const PORT = Number(process.env.PORT) || 4000;

// Websites allowed to call this server from the browser (comma-separated in .env).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Expose-Headers", "X-Chat-Limit, X-Chat-Remaining, X-Chat-Reset-At");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  applyCors(req, res);

  try {
    if ((pathname === "/api/chat" || pathname === "/api/chat/quota") && req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      return await handleChat(req, res);
    }
    if (pathname === "/api/chat/quota" && req.method === "GET") {
      return await handleQuota(req, res);
    }
    if (pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, apiKey: Boolean(process.env.ANTHROPIC_API_KEY) }));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("[server] unhandled error:", err);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`AI chatbot server running on http://localhost:${PORT}`);
  console.log(`Accepting requests from: ${allowedOrigins.join(", ")}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. Add it to AIChatbot/.env");
  }
  if (!process.env.MONGO_URI) {
    console.warn("Warning: MONGO_URI is not set, so conversations won't be saved for the admin panel and daily chat limits reset on restart.");
  }
});
