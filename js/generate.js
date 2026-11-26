// 呼叫 Groq → 驗證 JSON → 不合格就帶著錯誤重試（最多 3 次）
const Gen = (() => {
  const API = "https://api.groq.com/openai/v1/chat/completions";
  const MODEL = "qwen/qwen3.8-27b";
  const MAX_TRIES = 3;

  /* ---------- AI 品質紀錄 ----------
     每次呼叫 AI 記一筆：做什麼、試了幾次、每次被擋下的原因、成功或失敗、花幾秒。
     不記日記內容，只記數字和原因；交給 app.js 設定的 logger 存起來。 */
  let logger = null;
  const setLogger = (fn) => (logger = fn);

  // 把驗證錯誤歸類，方便統計
  function categorize(msg) {
    if (/JSON/.test(msg)) return "JSON 格式錯誤";
    if (/太長/.test(msg)) return "寫太長";
    if (/簡體/.test(msg)) return "出現簡體字";
    if (/照片/.test(msg)) return "照片 id 錯誤";
    if (/條列|分類|section_title/.test(msg)) return "備忘格式錯誤";
    if (/message_ids|漏掉|文字訊息|不存在的 id|重複出現/.test(msg)) return "原始風格分段錯誤";
    if (/心情/.test(msg)) return "心情格式錯誤";
    if (/缺少|必須是/.test(msg)) return "缺少欄位";
    return "其他";
  }
  function failCategory(e) {
    const m = e?.message || "";
    if (/API Key/.test(m)) return "API Key 無效";
    if (/額度/.test(m)) return "額度用完";
    if (/連不上/.test(m)) return "網路問題";
    if (/連續|沒有給出/.test(m)) return "重試後仍不合格";
    return "其他錯誤";
  }
  const startTrack = (kind, style, count) => ({ kind, style, count, tries: 0, reasons: [], start: Date.now() });
  function finishTrack(tr, ok, err) {
    if (!logger) return;
    try {
      logger({
        t: new Date().toISOString(),
        kind: tr.kind,
        style: tr.style || "",
        count: tr.count,
        tries: tr.tries,
        reasons: tr.reasons.map(categorize),
        ok,
        fail: ok ? "" : failCategory(err),
        ms: Date.now() - tr.start,
        model: MODEL,
      });
    } catch (e) {
      console.warn("[忘紀] 品質紀錄寫入失敗：", e);
    }
  }

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
    const tr = startTrack("mood", "", msgs.length);
    for (let attempt = 1; attempt <= 2; attempt++) {
      tr.tries = attempt;
      let raw;
      try {
        raw = await callGroq(key, conversation);
      } catch (e) {
        finishTrack(tr, false, e);
        throw e;
      }
      try {
        const mood = validMood(parseJSON(raw));
        if (mood) {
          finishTrack(tr, true);
          return mood;
        }
        tr.reasons.push("心情格式不對");
      } catch {
        tr.reasons.push("輸出不是合法的 JSON");
      }
    }
    finishTrack(tr, false, new Error("兩次都沒有給出可用的心情"));
    return null;
  }

  // 照片版型依張數校正；photo_notes 只留存在的照片、每句最多 30 字（只在編輯畫面顯示）
  function tidyPhotos(obj, imageIds) {
    obj.sections.forEach((s) => (s.layout = normalizeLayout(s.layout, (s.matched_images || []).length)));
    const notes = {};
    if (obj.photo_notes && typeof obj.photo_notes === "object") {
      Object.entries(obj.photo_notes).forEach(([id, text]) => {
        if (imageIds.includes(id) && isText(text)) notes[id] = text.trim().slice(0, 30);
      });
    }
    obj.photo_notes = notes;
  }

  // 月回顧：讀一個月的手札摘要，寫回顧。lines：每篇一行摘要；dates：這個月有手札的日期（YYYY-MM-DD）
  async function generateReview(lines, dates, monthLabel, key) {
    const tr = startTrack("review", "", lines.length);
    try {
      const out = await runReview(lines, dates, monthLabel, key, tr);
      finishTrack(tr, true);
      return out;
    } catch (e) {
      finishTrack(tr, false, e);
      throw e;
    }
  }

  async function runReview(lines, dates, monthLabel, key, tr) {
    const conversation = [
      {
        role: "system",
        content: `你會讀到一個人 ${monthLabel} 每天的手札摘要，每篇開頭是 [日期 YYYY-MM-DD｜心情]。請用他自己的口吻（第一人稱「我」）寫這個月的回顧，只輸出 JSON：
{"title": "一句話總結這個月，20 字以內", "summary": "2～3 段白話回顧，段落之間用 \\n 分隔", "happy": [{"date": "YYYY-MM-DD", "text": "開心的事"}], "annoying": [{"date": "YYYY-MM-DD", "text": "煩惱的事"}], "best_day": {"date": "YYYY-MM-DD", "reason": "為什麼"}, "worst_day": {"date": "YYYY-MM-DD", "reason": "為什麼"}}
規則：
- 只根據手札內容，不可新增沒寫過的事。
- happy、annoying 各最多 3 件，可以少於 3 件，沒有就給空陣列；同一件事不要重複。
- date 一定要是輸入裡出現過的日期。
- 口語、白話，像本人在回想這個月；不要文藝腔、不要比喻堆砌、不要雞湯、不要說教。
- 一律使用繁體中文。`,
      },
      { role: "user", content: lines.join("\n") },
    ];
    const inputText = lines.join("");
    let last = "";
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      tr.tries = attempt;
      const raw = await callGroq(key, conversation);
      let r = null;
      const errors = [];
      try {
        r = parseJSON(raw);
      } catch {
        errors.push("輸出不是合法的 JSON");
      }
      if (r) {
        if (!isText(r.title)) errors.push("缺少 title");
        if (!isText(r.summary)) errors.push("缺少 summary");
        const simp = findSimplified(`${r.title || ""}${r.summary || ""}`, inputText);
        if (simp.length) errors.push(`出現簡體字「${simp.join("、")}」，請改成繁體中文`);
      }
      if (!errors.length) {
        const items = (arr) =>
          (Array.isArray(arr) ? arr : [])
            .filter((x) => x && dates.includes(x.date) && isText(x.text))
            .slice(0, 3)
            .map((x) => ({ date: x.date, text: x.text.trim() }));
        const day = (d) => (d && dates.includes(d.date) && isText(d.reason) ? { date: d.date, reason: d.reason.trim() } : null);
        return {
          title: r.title.trim(),
          summary: r.summary.trim(),
          happy: items(r.happy),
          annoying: items(r.annoying),
          best_day: day(r.best_day),
          worst_day: day(r.worst_day),
        };
      }
      last = errors[0];
      tr.reasons.push(...errors);
      conversation.push(
        { role: "assistant", content: raw },
        { role: "user", content: `上一次的輸出有以下問題，請修正後重新輸出完整的 JSON：\n- ${errors.join("\n- ")}` }
      );
    }
    throw new Error(`AI 連續 ${MAX_TRIES} 次輸出不合格（${last}）`);
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
  // meta.kind："journal"（一鍵整理）或 "rewrite"（換風格／重寫），給品質紀錄用
  async function generateJournal(msgs, styleKey, key, onTry = () => {}, meta = {}) {
    const tr = startTrack(meta.kind || "journal", styleKey, msgs.length);
    try {
      const out = await runJournal(msgs, styleKey, key, onTry, tr);
      finishTrack(tr, true);
      return out;
    } catch (e) {
      finishTrack(tr, false, e);
      throw e;
    }
  }

  async function runJournal(msgs, styleKey, key, onTry, tr) {
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
      tr.tries = attempt;
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
        tidyPhotos(obj, imageIds);
        return { result: obj, tries: attempt };
      }

      lastErrors = result.errors;
      tr.reasons.push(...lastErrors);
      console.warn(`[忘紀] 第 ${attempt} 次輸出不合格：`, lastErrors);
      conversation.push(
        { role: "assistant", content: raw },
        { role: "user", content: `上一次的輸出有以下問題，請修正後重新輸出完整的 JSON：\n- ${lastErrors.join("\n- ")}` }
      );
    }
    throw new Error(`AI 連續 ${MAX_TRIES} 次輸出不合格（${lastErrors[0]}）`);
  }

  return { generateJournal, generateMood, generateReview, setLogger, validMood, testKey, formatTimeline, validate, placeMissing, convertRaw };
})();
