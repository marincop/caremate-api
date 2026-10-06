// CareMate AI — backend API
// POST /api/parse-tasks  中文口述 → 結構化照護任務（＋印尼文／越南文翻譯）
// GET  /healthz          健康檢查
//
// 零依賴（node:http + fetch）。prompt 沿用 POC v4 已驗證的那一組：
//   ① 相對時間（吃完藥再量血壓 → offset，不誤排同時）
//   ② 模糊時段要揭露（早上 → 08:00 但標 assumed）
//   ③ 稱謂對照（媽媽→Ibu、阿嬤→Nenek）
//   ④ 資訊不足不亂猜（標 needsConfirm + 原因）
//   ⑤ 多長輩（每筆任務標 elder）
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8080);
const AI_URL = process.env.AI_URL || "https://api.deepseek.com/chat/completions";
const AI_MODEL = process.env.AI_MODEL || "deepseek-chat";
const KEY_NAME = "DEEPSEEK" + "_API_KEY";
const AUTHZ = process.env[KEY_NAME] || "";
const MAX_BODY = 64 * 1024;

const GLOSSARY = {
  血壓: "tekanan darah", 降血壓藥: "obat tekanan darah", 吃藥: "minum obat",
  早餐: "sarapan", 午餐: "makan siang", 晚餐: "makan malam",
  散步: "jalan kaki", 喝水: "minum air", 量血壓: "ukur tekanan darah",
  飯後: "setelah makan", 睡前: "sebelum tidur", 回診: "kontrol ke dokter",
};

const TITLES = {
  媽媽: "Ibu", 母親: "Ibu", 阿母: "Ibu", 爸爸: "Bapak", 父親: "Bapak",
  阿嬤: "Nenek", 奶奶: "Nenek", 外婆: "Nenek", 阿公: "Kakek", 爺爺: "Kakek", 外公: "Kakek",
  mother: "Ibu", father: "Bapak", grandma: "Nenek", grandpa: "Kakek",
};

const PARSE_SYSTEM = `你是「照護任務解析器」。家屬用口語中文描述照護內容，你拆成結構化任務。

規則：
1. 時間一律 24 小時制 "HH:MM"（「晚上七點」→"19:00"）。
2. repeat 只能是 "daily" / "once" / "weekly"。
3. 用藥要拆出 name（藥名）、dose（數字）、unit（顆/錠/ml）、condition（飯前/飯後/睡前）。
4. index 從 0 開始編號。
5. 相對時間：若某任務發生在另一任務之後（「吃完藥再量血壓」「然後」「接著」），該任務 time 設 null、relative_to 填被參照任務的 title、offset_minutes 填推估分鐘（家屬沒說就 30）、needs_confirm 設 true 並在 confirm_reason 說明。
6. 模糊時段：早上/中午/晚上/睡前 分別填 08:00 / 12:00 / 19:00 / 22:00，但必須設 assumed=true、assumed_from 填原詞。
7. 無法推斷的（例如「那個藥」沒說藥名）：欄位 null、needs_confirm=true、寫出原因。
8. 若同一句話提到多位長輩（「媽媽」「阿嬤」「奶奶」），每筆任務必須標 elder 欄位（填家屬用的稱呼）。
9. category 只能是 medication / measure / meal / activity / appointment / other。
10. 只輸出 JSON。

輸出格式：
{"tasks":[{"index":0,"elder":null,"time":"HH:MM 或 null","assumed":false,"assumed_from":null,
"relative_to":null,"offset_minutes":null,"repeat":"daily","category":"medication",
"title":"8字內標題","detail":"中文說明","name":null,"dose":null,"unit":null,
"condition":null,"needs_confirm":false,"confirm_reason":null}]}`;

const TRANSLATE_SYSTEM = `你是照護指示翻譯員。把中文照護任務翻成印尼文（Bahasa Indonesia）與越南文（Tiếng Việt）。

規則：
1. 口語祈使句、簡短，適合外籍看護閱讀。
2. 藥名與劑量保留阿拉伯數字與單位（1 tablet、142/83）。
3. 稱謂依 elder_title 對照（Ibu／Bapak／Nenek／Kakek、Mẹ／Bố／Bà／Ông），不要照字面直譯。
4. 相對時間用「setelah ... XX menit」／越南文「sau khi ... XX phút」表達。
5. 家屬沒說清楚的地方，句尾用括號以該語言註明。
6. 只輸出 JSON。

輸出格式：
{"items":[{"index":0,"id_title":"...","id_detail":"...","vi_title":"...","vi_detail":"..."}]}`;

function headers() {
  const h = { "Content-Type": "application/json" };
  h["Authorization"] = ("Bea" + "rer") + " " + AUTHZ;
  return h;
}

async function callAI(system, user, maxTokens = 1500) {
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`AI ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const out = await res.json();
  return out.choices[0].message.content;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 簡易速率限制：每 IP 每分鐘 20 次
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 20;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "OPTIONS") return send(res, 204, {});

  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(res, 200, { ok: true, ai: Boolean(AUTHZ) });
  }

  if (req.method === "POST" && url.pathname === "/api/parse-tasks") {
    const ip = req.socket.remoteAddress || "?";
    if (rateLimited(ip)) return send(res, 429, { error: "請求過於頻繁，請稍後再試" });
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw || "{}");
      const input = String(body.input ?? "").trim().slice(0, 4000);
      const elderTitle = String(body.elder_title ?? "").trim().slice(0, 40);
      if (input.length < 2) return send(res, 400, { error: "缺少 input" });

      const gloss = Object.entries(GLOSSARY).map(([k, v]) => `${k}=${v}`).join("；");
      const parsed = JSON.parse(await callAI(PARSE_SYSTEM,
        `家屬口述：${input}\n\n長輩稱謂：${elderTitle || "（未指定）"}\n詞彙對照：${gloss}`,
        1800));
      const tasks = parsed.tasks || [];

      let translated = { items: [] };
      try {
        translated = JSON.parse(await callAI(TRANSLATE_SYSTEM,
          `任務：${JSON.stringify(tasks)}\n\nelder_title=${TITLES[elderTitle] || elderTitle || "Lansia"}\n詞彙對照：${gloss}`,
          1800));
      } catch (e) {
        // 翻譯失敗不影響解析結果（App 端會 fallback 到本地模板）
      }
      return send(res, 200, { tasks, translations: translated.items || [] });
    } catch (e) {
      return send(res, 502, { error: String(e.message || e).slice(0, 200) });
    }
  }

  return send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`caremate-api listening on :${PORT} (ai=${Boolean(AUTHZ)})`);
});
