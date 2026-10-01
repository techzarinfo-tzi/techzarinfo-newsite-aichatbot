import { getDb } from "./db.js";

// Daily question allowance for anonymous visitors (no login). Each person is tracked twice: by
// the visitor ID their browser keeps, and by their IP address, so clearing browser storage
// doesn't reset it. A question is refused when either one has used up its allowance.
//
// An allowance window starts with a visitor's first question and lasts 24 hours. The question
// that uses the last of the allowance restarts the window, so after hitting the limit a visitor
// waits a full 24 hours before they can chat again.
//
// Counts live in MongoDB (collection "chatquotas") so restarts and multiple instances share them;
// without MONGO_URI, or if the database is unreachable, they're kept in this process's memory.

const positiveInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return n > 0 ? n : fallback;
};

export const DAILY_LIMIT = positiveInt(process.env.CHAT_DAILY_LIMIT, 7);
const IP_DAILY_LIMIT = positiveInt(process.env.CHAT_IP_DAILY_LIMIT, DAILY_LIMIT);
const WINDOW_MS = 24 * 60 * 60 * 1000;
const COLLECTION = "chatquotas";

// { key, limit } for each identity a visitor is counted under.
function keysFor({ visitorId, ip }) {
  const keys = [{ key: `ip:${ip}`, limit: IP_DAILY_LIMIT }];
  if (visitorId) keys.unshift({ key: `v:${visitorId}`, limit: DAILY_LIMIT });
  return keys;
}

// --- MongoDB store ---------------------------------------------------------------------------

let collectionPromise;

function getCollection() {
  const db = getDb();
  if (!db) return null;
  collectionPromise ??= (async () => {
    const collection = (await db).collection(COLLECTION);
    // MongoDB deletes each record once its window has ended.
    await collection.createIndex({ resetAt: 1 }, { expireAfterSeconds: 0 });
    return collection;
  })().catch((err) => {
    collectionPromise = undefined;
    throw err;
  });
  return collectionPromise;
}

const mongoStore = {
  // Atomically: start a new window if the old one ended, then count one question if there's
  // allowance left. Returns { count, resetAt, allowed }.
  async take(collection, key, limit, now) {
    const nextReset = new Date(now.getTime() + WINDOW_MS);
    const expired = { $lte: [{ $ifNull: ["$resetAt", new Date(0)] }, now] };
    const doc = await collection.findOneAndUpdate(
      { _id: key },
      [
        {
          $set: {
            count: { $cond: [expired, 0, "$count"] },
            resetAt: { $cond: [expired, nextReset, "$resetAt"] },
          },
        },
        { $set: { allowed: { $lt: ["$count", limit] } } },
        {
          $set: {
            count: { $cond: ["$allowed", { $add: ["$count", 1] }, "$count"] },
            resetAt: {
              $cond: [{ $and: ["$allowed", { $gte: [{ $add: ["$count", 1] }, limit] }] }, nextReset, "$resetAt"],
            },
          },
        },
      ],
      { upsert: true, returnDocument: "after" }
    );
    return { count: doc.count, resetAt: doc.resetAt, allowed: doc.allowed };
  },

  async refund(collection, key) {
    await collection.updateOne({ _id: key, count: { $gt: 0 } }, { $inc: { count: -1 } });
  },

  async peek(collection, key, now) {
    const doc = await collection.findOne({ _id: key });
    return doc && doc.resetAt > now ? { count: doc.count, resetAt: doc.resetAt } : null;
  },
};

// --- In-memory store (fallback) --------------------------------------------------------------

const memory = new Map();

const memoryStore = {
  async take(_, key, limit, now) {
    let entry = memory.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: new Date(now.getTime() + WINDOW_MS) };
      memory.set(key, entry);
    }
    const allowed = entry.count < limit;
    if (allowed) {
      entry.count += 1;
      if (entry.count >= limit) entry.resetAt = new Date(now.getTime() + WINDOW_MS);
    }
    if (memory.size > 10000) {
      for (const [k, e] of memory) if (e.resetAt <= now) memory.delete(k);
    }
    return { count: entry.count, resetAt: entry.resetAt, allowed };
  },

  async refund(_, key) {
    const entry = memory.get(key);
    if (entry?.count > 0) entry.count -= 1;
  },

  async peek(_, key, now) {
    const entry = memory.get(key);
    return entry && entry.resetAt > now ? { ...entry } : null;
  },
};

// Runs an operation on MongoDB, or in memory when the database isn't configured or fails.
async function run(op, ...args) {
  const pending = getCollection();
  if (pending) {
    try {
      return await mongoStore[op](await pending, ...args);
    } catch (err) {
      console.error(`[quota] database unavailable, counting in memory: ${err.message}`);
    }
  }
  return memoryStore[op](null, ...args);
}

// --- Public API ------------------------------------------------------------------------------

// { limit, remaining, resetAt } where resetAt is set only once nothing remains: the time the
// visitor can chat again.
function summarize(results) {
  let remaining = DAILY_LIMIT;
  let resetAt = null;
  for (const { limit, count, resetAt: reset } of results) {
    remaining = Math.min(remaining, Math.max(0, limit - count));
    if (count >= limit && (!resetAt || reset > resetAt)) resetAt = reset;
  }
  return { limit: DAILY_LIMIT, remaining, resetAt: remaining === 0 ? resetAt : null };
}

// Counts one question against the visitor. Returns { allowed, limit, remaining, resetAt }.
export async function takeQuestion(who) {
  const now = new Date();
  const results = [];
  for (const { key, limit } of keysFor(who)) {
    results.push({ key, limit, ...(await run("take", key, limit, now)) });
  }
  const allowed = results.every((r) => r.allowed);
  if (!allowed) {
    // Refused questions don't use up the allowance of the identities that still had some.
    await Promise.all(results.filter((r) => r.allowed).map((r) => run("refund", r.key)));
    for (const r of results) if (r.allowed) r.count -= 1;
  }
  return { allowed, ...summarize(results) };
}

// Gives back a question that got no answer (e.g. the AI service failed).
export async function refundQuestion(who) {
  await Promise.all(keysFor(who).map(({ key }) => run("refund", key)));
}

// The visitor's current allowance, without using any of it.
export async function getQuota(who) {
  const now = new Date();
  const results = await Promise.all(
    keysFor(who).map(async ({ key, limit }) => ({ limit, count: 0, ...(await run("peek", key, now)) }))
  );
  return summarize(results);
}
