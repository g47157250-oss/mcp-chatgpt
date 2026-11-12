import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
await db.execute("DELETE FROM tasks");
console.log("cleaned:", (await db.execute("SELECT COUNT(*) c FROM tasks")).rows[0].c, "tasks remain");
