import { MongoClient } from "mongodb";

// One shared connection to the website's MongoDB (MONGO_URI), or null when it isn't configured.
// A failed connection is retried on the next call.
let dbPromise;

export function getDb() {
  if (!process.env.MONGO_URI) return null;
  dbPromise ??= (async () => {
    const client = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    return client.db();
  })().catch((err) => {
    dbPromise = undefined;
    throw err;
  });
  return dbPromise;
}
