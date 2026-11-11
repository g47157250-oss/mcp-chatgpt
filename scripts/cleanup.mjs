import { createClient } from "@libsql/client";
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
// حذف المفتاح الخاطئ نهائيًا — يبقى المفتاح الحقيقي فقط
await db.execute({ sql: "DELETE FROM api_keys WHERE label = ?", args: ["خاطئ"] });
const k = await db.execute("SELECT label, status FROM api_keys");
for (const row of k.rows) console.log(JSON.stringify(row));
