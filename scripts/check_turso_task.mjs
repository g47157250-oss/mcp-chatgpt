import { createClient } from "@libsql/client";
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const r = await db.execute({ sql: "SELECT id, provider_task_id, status, progress, error_message FROM tasks ORDER BY created_at DESC LIMIT 5", args: [] });
for (const row of r.rows) console.log(JSON.stringify(row));
