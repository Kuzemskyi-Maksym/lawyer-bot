import { NextRequest } from "next/server";
import { MongoClient, ObjectId } from "mongodb";

const BOT_TOKEN = process.env.BOT_TOKEN!;
const MONGO_URI = process.env.MONGO_URI!;
const CRON_SECRET = process.env.CRON_SECRET || "";

export const runtime = "nodejs";

type Task = {
    _id: ObjectId;
    chatId: number;
    text: string;
    done: boolean;
    priority: "звичайна" | "важлива" | "критична";
    deadline?: Date;
    reminded10?: boolean;
    remindedDue?: boolean;
};

declare global {
    var _mongoClient: MongoClient | undefined;
}

async function getDb() {
    if (!global._mongoClient) {
        global._mongoClient = new MongoClient(MONGO_URI, {
            serverSelectionTimeoutMS: 5000,
            connectTimeoutMS: 10000,
        });
    }
    const client = global._mongoClient;
    try {
        await client.db("admin").command({ ping: 1 });
    } catch {
        await client.connect();
    }
    return client.db("organizer");
}

async function sendMessage(chatId: number, text: string) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    console.log("sendMessage result:", JSON.stringify(data));
    return data;
}

export async function GET(req: NextRequest) {
    const secret = req.headers.get("x-cron-secret") || "";
    if (CRON_SECRET && secret !== CRON_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const in10 = new Date(now.getTime() + 10 * 60 * 1000);
    console.log("Cron run at UTC:", now.toISOString());

    let db;
    try {
        db = await getDb();
    } catch (e) {
        console.error("MongoDB connection failed:", e);
        return Response.json({ error: "DB connection failed" }, { status: 500 });
    }

    const tasks = await db
        .collection<Task>("tasks")
        .find({ done: false, deadline: { $exists: true } })
        .toArray();

    console.log("Tasks found:", tasks.length);
    tasks.forEach(t => {
        console.log(`Task: ${t.text}, deadline: ${t.deadline}, reminded10: ${t.reminded10}, remindedDue: ${t.remindedDue}`);
    });

    let sent = 0;
    const PRIORITY_ICON = { звичайна: "🟢", важлива: "🟡", критична: "🔴" };

    for (const task of tasks) {
        if (!task.deadline) continue;
        const dl = new Date(task.deadline);
        const icon = PRIORITY_ICON[task.priority] ?? "▫️";

        console.log(`Checking task "${task.text}": dl=${dl.toISOString()}, now=${now.toISOString()}, in10=${in10.toISOString()}`);

        // За 10 хвилин
        if (!task.reminded10 && dl > now && dl <= in10) {
            console.log("Sending 10min reminder for:", task.text);
            await sendMessage(
                task.chatId,
                `⏰ <b>За 10 хвилин!</b>\n${icon} ${task.text}\n\nДедлайн: ${dl.toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" })}`
            );
            await db.collection<Task>("tasks").updateOne({ _id: task._id }, { $set: { reminded10: true } });
            sent++;
        }

        // В момент дедлайну (до 30 хв після)
        const thirtyMinAfter = new Date(dl.getTime() + 30 * 60 * 1000);
        if (!task.remindedDue && dl <= now && now <= thirtyMinAfter) {
            console.log("Sending due reminder for:", task.text);
            await sendMessage(
                task.chatId,
                `🔔 <b>Дедлайн!</b>\n${icon} ${task.text}`
            );
            await db.collection<Task>("tasks").updateOne({ _id: task._id }, { $set: { remindedDue: true } });
            sent++;
        }
    }

    console.log("Sent:", sent);
    return Response.json({ ok: true, checked: tasks.length, sent, now: now.toISOString() });
}