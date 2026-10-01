import { getDb } from "./db.js";

// Every visitor question and the answer they were shown, one document per conversation, in the
// same MongoDB as the website backend (which reads them for the admin panel). Saving is best
// effort: if the database is down or MONGO_URI is unset, chats keep working and nothing is stored.
const COLLECTION = "chatconversations";

let collectionPromise;

function getCollection() {
  const db = getDb();
  if (!db) return null;
  collectionPromise ??= (async () => {
    const collection = (await db).collection(COLLECTION);
    await collection.createIndexes([
      { key: { conversationId: 1 }, unique: true },
      { key: { updatedAt: -1 } },
      { key: { visitorId: 1, updatedAt: -1 } },
    ]);
    return collection;
  })().catch((err) => {
    collectionPromise = undefined; // try again on the next message
    throw err;
  });
  return collectionPromise;
}

// status: "answered" | "refused" | "cut_off" | "failed" | "stopped" (visitor closed the chat)
export async function saveExchange({ conversationId, visitorId, ip, question, answer, status, askedAt }) {
  const pending = getCollection();
  if (!pending) return;
  const collection = await pending;
  const now = new Date();
  await collection.updateOne(
    { conversationId },
    {
      $setOnInsert: { conversationId, createdAt: askedAt },
      $set: { updatedAt: now, visitorId, ip },
      $inc: { questionCount: 1 },
      $push: {
        messages: {
          $each: [
            { role: "user", content: question, createdAt: askedAt },
            { role: "assistant", content: answer, status, createdAt: now },
          ],
        },
      },
    },
    { upsert: true }
  );
}
