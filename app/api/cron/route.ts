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

// ── MongoDB singleton ─────────────────────────────────────────────────────────

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

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendMessage(chatId: number, text: string) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
}

// ── Cron handler ──────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
    // захист — тільки GitHub Actions може викликати
    const secret = req.headers.get("x-cron-secret") || "";
    if (CRON_SECRET && secret !== CRON_SECRET) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const now = new Date();
    const in10 = new Date(now.getTime() + 10 * 60 * 1000); // +10 хвилин

    // Знайти всі активні справи з дедлайном
    const tasks = await db
        .collection<Task>("tasks")
        .find({ done: false, deadline: { $exists: true } })
        .toArray();

    let sent = 0;

    for (const task of tasks) {
        if (!task.deadline) continue;
        const dl = new Date(task.deadline);

        const PRIORITY_ICON = { звичайна: "🟢", важлива: "🟡", критична: "🔴" };
        const icon = PRIORITY_ICON[task.priority] ?? "▫️";

        // Нагадування за 10 хвилин
        if (!task.reminded10 && dl > now && dl <= in10) {
            await sendMessage(
                task.chatId,
                `⏰ <b>За 10 хвилин!</b>\n${icon} ${task.text}\n\nДедлайн: ${dl.toLocaleString("uk-UA")}`
            );
            await db
                .collection<Task>("tasks")
                .updateOne({ _id: task._id }, { $set: { reminded10: true } });
            sent++;
        }

        // Нагадування в момент дедлайну (або вже минув — до 30 хв після)
        const thirtyMinAfter = new Date(dl.getTime() + 30 * 60 * 1000);
        if (!task.remindedDue && dl <= now && now <= thirtyMinAfter) {
            await sendMessage(
                task.chatId,
                `🔔 <b>Дедлайн!</b>\n${icon} ${task.text}`
            );
            await db
                .collection<Task>("tasks")
                .updateOne({ _id: task._id }, { $set: { remindedDue: true } });
            sent++;
        }
    }

    return Response.json({ ok: true, checked: tasks.length, sent });
}