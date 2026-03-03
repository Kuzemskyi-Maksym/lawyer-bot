import { NextRequest } from "next/server";
import { MongoClient, ObjectId } from "mongodb";

const BOT_TOKEN = process.env.BOT_TOKEN!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const MONGO_URI = process.env.MONGO_URI!;

export const runtime = "nodejs";

type TgUpdate = {
    message?: { chat?: { id: number }; text?: string };
    callback_query?: {
        id: string;
        message?: { chat?: { id: number } };
        data?: string;
    };
};

type TaskType = "договір" | "суд" | "лист" | "платіж" | "зустріч" | "інше";
type Priority = "звичайна" | "важлива" | "критична";

type Task = {
    _id?: ObjectId;
    chatId: number;
    text: string;
    done: boolean;
    type: TaskType;
    priority: Priority;
    createdAt: Date;
};

type PendingState = "add_text" | "add_type" | "add_priority" | "done_pick" | "del_pick";
type Pending = { state: PendingState; draft?: Partial<Task> };

// ── MongoDB singleton (Vercel-safe) ──────────────────────────────────────────

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

async function getTasks(chatId: number): Promise<Task[]> {
    const db = await getDb();
    return db.collection<Task>("tasks").find({ chatId, done: false }).sort({ createdAt: 1 }).toArray();
}

async function addTask(task: Omit<Task, "_id">): Promise<void> {
    const db = await getDb();
    await db.collection<Task>("tasks").insertOne(task as Task);
}

async function markDone(chatId: number, index: number): Promise<Task | null> {
    const tasks = await getTasks(chatId);
    if (index < 0 || index >= tasks.length) return null;
    const task = tasks[index];
    const db = await getDb();
    await db.collection<Task>("tasks").updateOne({ _id: task._id }, { $set: { done: true } });
    return task;
}

async function deleteTask(chatId: number, index: number): Promise<Task | null> {
    const tasks = await getTasks(chatId);
    if (index < 0 || index >= tasks.length) return null;
    const task = tasks[index];
    const db = await getDb();
    await db.collection<Task>("tasks").deleteOne({ _id: task._id });
    return task;
}

// ── In-memory pending ────────────────────────────────────────────────────────

const pendingByChat = new Map<number, Pending>();

// ── Telegram ─────────────────────────────────────────────────────────────────

async function tg(method: string, payload: object) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("TG error", method, await res.text());
}

function mainMenu() {
    return {
        inline_keyboard: [
            [{ text: "➕ Додати справу", callback_data: "ADD" }],
            [{ text: "📋 Мої справи", callback_data: "LIST" }],
            [{ text: "✅ Виконано", callback_data: "DONE" }, { text: "🗑 Видалити", callback_data: "DEL" }],
        ],
    };
}

function backMenu() {
    return { inline_keyboard: [[{ text: "⬅️ Назад", callback_data: "MENU" }]] };
}

function typeMenu() {
    return {
        inline_keyboard: [
            [{ text: "📄 Договір", callback_data: "TYPE_договір" }, { text: "⚖️ Суд", callback_data: "TYPE_суд" }],
            [{ text: "✉️ Лист", callback_data: "TYPE_лист" }, { text: "💳 Платіж", callback_data: "TYPE_платіж" }],
            [{ text: "🤝 Зустріч", callback_data: "TYPE_зустріч" }, { text: "📌 Інше", callback_data: "TYPE_інше" }],
            [{ text: "⬅️ Назад", callback_data: "MENU" }],
        ],
    };
}

function priorityMenu() {
    return {
        inline_keyboard: [
            [
                { text: "🟢 Звичайна", callback_data: "PRI_звичайна" },
                { text: "🟡 Важлива", callback_data: "PRI_важлива" },
                { text: "🔴 Критична", callback_data: "PRI_критична" },
            ],
            [{ text: "⬅️ Назад", callback_data: "MENU" }],
        ],
    };
}

const PRIORITY_ICON: Record<Priority, string> = { звичайна: "🟢", важлива: "🟡", критична: "🔴" };
const TYPE_ICON: Record<TaskType, string> = { договір: "📄", суд: "⚖️", лист: "✉️", платіж: "💳", зустріч: "🤝", інше: "📌" };

function formatTasks(tasks: Task[]): string {
    if (!tasks.length) return "Справ немає 🙌";
    return tasks.map((t, i) => `${i + 1}. ${PRIORITY_ICON[t.priority]} ${TYPE_ICON[t.type]} ${t.text}`).join("\n");
}

// ── Головний обробник ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
    if (!BOT_TOKEN) return Response.json({ error: "BOT_TOKEN missing" }, { status: 500 });

    if (WEBHOOK_SECRET) {
        const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
        if (got !== WEBHOOK_SECRET) return Response.json({ error: "Bad secret" }, { status: 401 });
    }

    const update = (await req.json()) as TgUpdate;

    if (update.callback_query?.data) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const data = cq.data!;

        void tg("answerCallbackQuery", { callback_query_id: cq.id });
        if (!chatId) return Response.json({ ok: true });

        if (data === "MENU") {
            pendingByChat.delete(chatId);
            void tg("sendMessage", { chat_id: chatId, text: "✅ Меню:", reply_markup: mainMenu() });
            return Response.json({ ok: true });
        }

        if (data === "ADD") {
            pendingByChat.set(chatId, { state: "add_text", draft: {} });
            void tg("sendMessage", { chat_id: chatId, text: "Напиши текст справи ✍️", reply_markup: backMenu() });
            return Response.json({ ok: true });
        }

        if (data.startsWith("TYPE_")) {
            const type = data.replace("TYPE_", "") as TaskType;
            const p = pendingByChat.get(chatId);
            if (p?.state === "add_type") {
                p.draft!.type = type;
                p.state = "add_priority";
                pendingByChat.set(chatId, p);
                void tg("sendMessage", { chat_id: chatId, text: "Рівень важливості:", reply_markup: priorityMenu() });
            }
            return Response.json({ ok: true });
        }

        if (data.startsWith("PRI_")) {
            const priority = data.replace("PRI_", "") as Priority;
            const p = pendingByChat.get(chatId);
            if (p?.state === "add_priority" && p.draft?.text && p.draft?.type) {
                await addTask({ chatId, text: p.draft.text, type: p.draft.type, priority, done: false, createdAt: new Date() });
                pendingByChat.delete(chatId);
                const hint = p.draft.type === "суд" ? "\n⚠️ Судова справа — контроль строків критичний."
                    : p.draft.type === "платіж" ? "\n⚠️ Перевір строк оплати." : "";
                void tg("sendMessage", {
                    chat_id: chatId,
                    text: `➕ Справу додано!\n${PRIORITY_ICON[priority]} ${TYPE_ICON[p.draft.type]} ${p.draft.text}${hint}`,
                    reply_markup: mainMenu(),
                });
            }
            return Response.json({ ok: true });
        }

        if (data === "LIST") {
            pendingByChat.delete(chatId);
            const tasks = await getTasks(chatId);
            void tg("sendMessage", { chat_id: chatId, text: `📋 Активні справи:\n\n${formatTasks(tasks)}`, reply_markup: mainMenu() });
            return Response.json({ ok: true });
        }

        if (data === "DONE") {
            const tasks = await getTasks(chatId);
            pendingByChat.set(chatId, { state: "done_pick" });
            void tg("sendMessage", { chat_id: chatId, text: `Номер виконаної справи:\n\n${formatTasks(tasks)}`, reply_markup: backMenu() });
            return Response.json({ ok: true });
        }

        if (data === "DEL") {
            const tasks = await getTasks(chatId);
            pendingByChat.set(chatId, { state: "del_pick" });
            void tg("sendMessage", { chat_id: chatId, text: `Номер справи для видалення:\n\n${formatTasks(tasks)}`, reply_markup: backMenu() });
            return Response.json({ ok: true });
        }

        void tg("sendMessage", { chat_id: chatId, text: "Невідома дія. Спробуй /start", reply_markup: mainMenu() });
        return Response.json({ ok: true });
    }

    const chatId = update.message?.chat?.id;
    const text = (update.message?.text || "").trim();
    if (!chatId || !text) return Response.json({ ok: true });

    if (text === "/start" || text === "/menu") {
        pendingByChat.delete(chatId);
        void tg("sendMessage", { chat_id: chatId, text: "👋 Органайзер юриста онлайн. Обирай дію:", reply_markup: mainMenu() });
        return Response.json({ ok: true });
    }

    if (text.toLowerCase() === "назад") {
        pendingByChat.delete(chatId);
        void tg("sendMessage", { chat_id: chatId, text: "✅ Меню:", reply_markup: mainMenu() });
        return Response.json({ ok: true });
    }

    const pending = pendingByChat.get(chatId);

    if (pending?.state === "add_text") {
        pending.draft!.text = text;
        pending.state = "add_type";
        pendingByChat.set(chatId, pending);
        void tg("sendMessage", { chat_id: chatId, text: "Тип справи:", reply_markup: typeMenu() });
        return Response.json({ ok: true });
    }

    if (pending?.state === "done_pick") {
        const task = await markDone(chatId, Number(text) - 1);
        pendingByChat.delete(chatId);
        void tg("sendMessage", { chat_id: chatId, text: task ? `✅ Виконано: ${task.text}` : "Не знайшов таку справу.", reply_markup: mainMenu() });
        return Response.json({ ok: true });
    }

    if (pending?.state === "del_pick") {
        const task = await deleteTask(chatId, Number(text) - 1);
        pendingByChat.delete(chatId);
        void tg("sendMessage", { chat_id: chatId, text: task ? `🗑 Видалено: ${task.text}` : "Не знайшов таку справу.", reply_markup: mainMenu() });
        return Response.json({ ok: true });
    }

    void tg("sendMessage", { chat_id: chatId, text: "Обирай дію кнопками 👇", reply_markup: mainMenu() });
    return Response.json({ ok: true });
}