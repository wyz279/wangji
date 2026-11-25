// 呼叫 Groq → 驗證 JSON → 不合格就帶著錯誤重試（最多 3 次）
const Gen = (() => {
  const API = "https://api.groq.com/openai/v1/chat/completions";
  const MODEL = "qwen/qwen3.8-27b";
  const MAX_TRIES = 3;

  const pad = (n) => String(n).padStart(2, "0");
  function stamp(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const byTime = (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp);

  // 把訊息轉成送給 AI 的時間軸文字（照片只送佔位符）。raw 風格要附上每則訊息的 id
  // 貼圖只當「當下情緒」的參考：寫成 [貼圖：😭 大哭]；原汁原味不需要，直接略過
  function formatTimeline(msgs, withIds = false, skipImages = false) {
    return msgs
      .filter((m) => !(skipImages && m.type === "image"))
      .filter((m) => !(withIds && m.type === "sticker"))
      .map((m) => {
        const t = `[${stamp(m.timestamp)}]`;
        if (m.type === "sticker") return `${t} [貼圖：${[m.emoji, m.label].filter(Boolean).join(" ")}]`;
        if (withIds) return `${t} (${m.id}) ${m.type === "image" ? "[圖片]" : m.content}`;
        return m.type === "image" ? `${t} [圖片 ${m.id}]` : `${t} ${m.content}`;
      })
      .join("\n");
  }

  // raw 專用：檢查 message_ids，合格就用原話組出 refined_text / matched_images
  function convertRaw(obj, msgs) {
    if (!obj || !Array.isArray(obj.sections)) return ["sections 必須是陣列"];
    const errors = [];
    const byId = new Map(msgs.map((m) => [m.id, m]));
    const seen = new Map();
    obj.sections.forEach((s, i) => {
      const n = i + 1;
      if (!Array.isArray(s.message_ids)) return errors.push(`第 ${n} 段缺少 message_ids`);
      s.message_ids.forEach((id) => {
        if (!byId.has(id)) errors.push(`第 ${n} 段出現不存在的 id「${id}」`);
        seen.set(id, (seen.get(id) || 0) + 1);
      });
      if (!s.message_ids.some((id) => byId.get(id)?.type === "text")) errors.push(`第 ${n} 段沒有任何文字訊息`);
    });
    seen.forEach((c, id) => c > 1 && byId.has(id) && errors.push(`${id} 重複出現 ${c} 次`));
    msgs.filter((m) => m.type === "text" && !seen.has(m.id)).forEach((m) => errors.push(`漏掉了文字訊息 ${m.id}`));
    if (errors.length) return errors;

    obj.sections.forEach((s) => {
      const ms = s.message_ids.map((id) => byId.get(id)).sort(byTime);
      s.refined_text = ms.filter((m) => m.type === "text").map((m) => m.content).join("\n");
      s.matched_images = ms.filter((m) => m.type === "image").map((m) => m.id);
      delete s.message_ids;
    });
    return [];
  }

  // 去掉可能出現的思考標籤，抓出 JSON 本體
  function parseJSON(text) {
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    return JSON.parse(match ? match[0] : cleaned);
  }

  const isText = (v) => typeof v === "string" && v.trim() !== "";

  // 規格第 4 節的 5 條檢查。missing（漏放的照片）另外回傳，由程式補位，不浪費重試次數
  // 常見「只有簡體才會出現」的字。使用者原文裡本來就有的字不算（避免原汁原味或保留口吻時誤判）
  const SIMPLIFIED = "这们个来时对会为发过还没现实问题关开门见长样东车钱买卖书话认让请谢应该觉学习经济柜欢爱电脑办难单号吗说国进运动机节线级红绿蓝鸡鱼鸟饭馆饿饮业从众两产亲头宝带帮广庆归当录怀总战报择换数断显权杂条极楼标汉沟泪洁浅测湾满灯烦爷师听读写练试课评远连选递错锁镜闹阅陆随雾顺须领频颜风飞饱驾验边达岁";
  function findSimplified(text, inputText) {
    return [...new Set([...text].filter((c) => SIMPLIFIED.includes(c) && !inputText.includes(c)))];
  }

  function validate(obj, imageIds, styleKey, inputText = "") {
    const errors = [];
    if (!obj || typeof obj !== "object") return { errors: ["輸出不是 JSON 物件"], missing: [] };
    if (!isText(obj.title)) errors.push("缺少 title 或 title 是空的");
    if (!Array.isArray(obj.sections) || obj.sections.length < 1 || obj.sections.length > 6) {
      errors.push("sections 必須是 1～6 段的陣列");
      return { errors, missing: [] };
    }

    const seen = new Map();
    obj.sections.forEach((s, i) => {
      const n = i + 1;
      if (styleKey === "memo" && !MEMO_SECTIONS.includes(s.section_title)) {
        errors.push(`第 ${n} 段的 section_title 必須是「${MEMO_SECTIONS.join("」「")}」其中之一`);
      }
      if (!isText(s.refined_text)) errors.push(`第 ${n} 段缺少 refined_text`);
      else if (styleKey === "memo" && !s.refined_text.split("\n").filter((l) => l.trim()).every((l) => l.trim().startsWith("- "))) {
        errors.push(`第 ${n} 段不是條列格式，每一行都要以「- 」開頭`);
      }
      if (styleKey === "memo") s.matched_images = []; // 備忘錄的照片統一放最後，忽略 AI 的安排
      if (s.matched_images == null) s.matched_images = [];
      if (!Array.isArray(s.matched_images)) {
        errors.push(`第 ${n} 段的 matched_images 必須是陣列`);
        return;
      }
      s.matched_images.forEach((id) => {
        if (!imageIds.includes(id)) errors.push(`第 ${n} 段出現不存在的照片 id「${id}」`);
        seen.set(id, (seen.get(id) || 0) + 1);
      });
    });
    if (styleKey === "memo") {
      const titles = obj.sections.map((s) => s.section_title);
      if (new Set(titles).size !== titles.length) errors.push("同一個分類出現了兩次，每個分類只能有一個區塊");
    }
    seen.forEach((count, id) => {
      if (count > 1 && imageIds.includes(id)) errors.push(`照片 ${id} 重複出現 ${count} 次，每張只能放一次`);
    });

    // 長度上限：避免 AI 自己加戲寫成長篇（倍數 × 原文字數 + 40）
    const LENGTH_CAP = { daily: 1.4, doomsday: 2, optimist: 3, social: 1.2 };
    if (LENGTH_CAP[styleKey] && inputText) {
      const limit = Math.round(LENGTH_CAP[styleKey] * inputText.length + 40);
      const total = obj.sections.reduce((n, s) => n + (s.refined_text || "").length, 0);
      if (total > limit) errors.push(`寫太長了：原文 ${inputText.length} 字，你寫了 ${total} 字，請精簡到 ${limit} 字以內，不要自己加戲`);
    }

    const written = [obj.title, ...obj.sections.flatMap((s) => [s.section_title || "", s.refined_text || ""])].join("");
    const simp = findSimplified(written, inputText);
    if (simp.length) errors.push(`出現簡體字「${simp.join("、")}」，請全部改成繁體中文`);

    const missing = imageIds.filter((id) => !seen.has(id));
    return { errors, missing };
  }

  // 保底：漏放的照片 → 放進開始時間不晚於照片時間的最後一段
  function placeMissing(obj, missing, msgs) {
    const batchStart = new Date(msgs[0].timestamp);
    const starts = obj.sections.map((s) => {
      const m = /^(\d{1,2}):(\d{2})/.exec(s.time_range || "");
      if (!m) return null;
      const d = new Date(batchStart);
      d.setHours(+m[1], +m[2], 0, 0);
      if (d < batchStart - 60000) d.setDate(d.getDate() + 1); // 跨過午夜
      return d.getTime();
    });
    missing.forEach((id) => {
      const t = Date.parse(msgs.find((m) => m.id === id).timestamp);
      let target = 0;
      starts.forEach((st, i) => {
        if (st !== null && st <= t) target = i;
      });
      obj.sections[target].matched_images.push(id);
    });
  }

  // 心情格式不對就當作沒有（不為了心情浪費重試次數）
  function validMood(m) {
    if (!m || typeof m !== "object") return null;
    const score = Math.round(Number(m.score));
    if (!(score >= 1 && score <= 5) || !isText(m.label)) return null;
    return { emoji: isText(m.emoji) ? [...m.emoji.trim()].slice(0, 4).join("") : "📔", label: m.label.trim().slice(0, 6), score };
  }

  // 舊手札補心情：只問心情，不重寫內容
  async function generateMood(msgs, key) {
    const conversation = [
      {
        role: "system",
        content: `你會讀到一個人一整天隨手記下的碎碎念，每行是 [月/日 時:分] 內容。請判斷他這一天的整體心情，只輸出 JSON：
{"emoji": "一個 emoji", "label": "兩到四個字的繁體中文，例如：崩潰、還行、超爽", "score": 1～5 的整數（1 很糟、2 不太好、3 普通、4 不錯、5 超好）}
依他實際表達的情緒判斷，不要腦補。`,
      },
      { role: "user", content: formatTimeline(msgs, false, true) },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const mood = validMood(parseJSON(await callGroq(key, conversation)));
        if (mood) return mood;
      } catch (e) {
        if (/API Key|額度|連不上/.test(e.message)) throw e;
      }
    }
    return null;
  }

  async function callGroq(key, messages) {
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.6,
          response_format: { type: "json_object" },
          messages,
        }),
      });
    } catch {
      throw new Error("連不上 Groq，請檢查網路");
    }
    await checkResponse(res);
    const data = await res.json();
    return data.choices[0].message.content;
  }

  async function checkResponse(res) {
    if (res.ok) return;
    const body = await res.json().catch(() => ({}));
    const detail = body?.error?.message || "";
    console.warn("[忘紀] Groq 錯誤：", res.status, body);
    if (res.status === 401) throw new Error("API Key 無效，請到設定按「測試連線」檢查");
    if (res.status === 429) throw new Error("Groq 額度暫時用完，等一下再試");
    throw new Error(`Groq 回傳錯誤（HTTP ${res.status}）${detail ? "：" + detail : ""}`);
  }

  // 設定頁的「測試連線」：只讀模型清單，不花生成額度
  async function testKey(key) {
    let res;
    try {
      res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    } catch {
      throw new Error("連不上 Groq，請檢查網路");
    }
    await checkResponse(res);
  }

  // msgs：要整理的訊息（已依時間排序）。onTry(n)：第 n 次嘗試時呼叫，用來更新按鈕文字
  async function generateJournal(msgs, styleKey, key, onTry = () => {}) {
    const isMemo = styleKey === "memo";
    const imageIds = isMemo ? [] : msgs.filter((m) => m.type === "image").map((m) => m.id);
    const inputText = msgs.filter((m) => m.type === "text").map((m) => m.content).join("");
    const conversation = [
      { role: "system", content: buildSystemPrompt(styleKey) },
      { role: "user", content: formatTimeline(msgs, styleKey === "raw", isMemo) },
    ];

    let lastErrors = [];
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      onTry(attempt);
      const raw = await callGroq(key, conversation);

      let obj = null;
      let result;
      try {
        obj = parseJSON(raw);
        const rawErrors = styleKey === "raw" ? convertRaw(obj, msgs) : [];
        result = rawErrors.length ? { errors: rawErrors, missing: [] } : validate(obj, imageIds, styleKey, inputText);
      } catch {
        result = { errors: ["輸出不是合法的 JSON"], missing: [] };
      }

      if (result.errors.length === 0) {
        if (result.missing.length) placeMissing(obj, result.missing, msgs);
        return { result: obj, tries: attempt };
      }

      lastErrors = result.errors;
      console.warn(`[忘紀] 第 ${attempt} 次輸出不合格：`, lastErrors);
      conversation.push(
        { role: "assistant", content: raw },
        { role: "user", content: `上一次的輸出有以下問題，請修正後重新輸出完整的 JSON：\n- ${lastErrors.join("\n- ")}` }
      );
    }
    throw new Error(`AI 連續 ${MAX_TRIES} 次輸出不合格（${lastErrors[0]}）`);
  }

  return { generateJournal, generateMood, validMood, testKey, formatTimeline, validate, placeMissing, convertRaw };
})();
