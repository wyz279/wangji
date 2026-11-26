// 把資料轉成 HTML：聊天泡泡、手札列表、手札內頁
const Render = (() => {
  const urlCache = new Map();
  function imgURL(msg) {
    if (!urlCache.has(msg.id)) urlCache.set(msg.id, URL.createObjectURL(msg.blob));
    return urlCache.get(msg.id);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // 貼圖的樣子：內建是 emoji，自訂是圖片
  const stickerFace = (m) => (m.blob ? `<img src="${imgURL(m)}" alt="貼圖">` : esc(m.emoji));

  // 用 id 算出固定的「隨機」數，讓同一張貼紙每次都貼在一樣的角度和位置
  function hash(str) {
    let h = 0;
    for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0;
    return Math.abs(h);
  }

  const pad = (n) => String(n).padStart(2, "0");
  const time = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const WEEK = "日一二三四五六";
  const date = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`;
  };
  // 手札屬於哪一天：凌晨 3 點前開始的，算前一天（熬夜還沒睡）
  function dayLabel(j) {
    const d = new Date(j.range[0]);
    if (d.getHours() < 3) d.setDate(d.getDate() - 1);
    return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`;
  }
  const times = ([a, b]) => `${time(a)}～${time(b)}`;
  const range = ([a, b]) => (date(a) === date(b) ? `${date(a)} ${time(a)}～${time(b)}` : `${date(a)} ${time(a)}～${date(b)} ${time(b)}`);

  // 聊天室：未整理的訊息 + 已整理成手札的「小卡」（放在該手札最後一則訊息的時間點）
  // ui：{ selectedId, editingId } 目前選取／編輯中的訊息
  function chat(msgs, journals = [], ui = {}) {
    if (msgs.length === 0 && journals.length === 0) {
      return `<p class="empty-hint">今天發生什麼事？<br>想到什麼就丟進來，晚點再一鍵整理成手札。</p>`;
    }
    const items = [
      ...msgs.map((m) => ({ t: m.timestamp, m })),
      ...journals.map((j) => ({ t: j.range[1], j })),
    ].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

    let lastDate = "";
    return items
      .map(({ t, m, j }) => {
        let html = "";
        const d = date(t);
        if (d !== lastDate) {
          html += `<div class="date-sep">${d}</div>`;
          lastDate = d;
        }
        if (j) {
          return html + `<button class="chat-journal" data-id="${j.id}">
            📔 ${dayLabel(j)} 的手札：「${esc(j.result.title)}」
            <span>${times(j.range)}・點我查看</span>
          </button>`;
        }
        const processing = m.journal_id === "processing";
        const editing = ui.editingId === m.id;
        let body;
        if (editing) {
          body = `<div class="edit-box">
            <textarea id="editInput" rows="3">${esc(m.content)}</textarea>
            <div class="msg-actions"><button data-act="cancel">取消</button><button data-act="save" class="save">儲存</button></div>
          </div>`;
        } else {
          body =
            m.type === "image"
              ? `<img src="${imgURL(m)}" alt="照片">`
              : m.type === "sticker"
                ? `<div class="chat-sticker">${stickerFace(m)}</div>`
                : `<div class="bubble">${esc(m.content)}</div>`;
        }
        const tag = processing ? `<span class="tag">整理中</span>` : "";
        const edited = m.edited ? "・已編輯" : "";
        const actions =
          ui.selectedId === m.id && !editing && !processing
            ? `<div class="msg-actions">${m.type === "text" ? `<button data-act="edit">編輯</button>` : ""}<button data-act="delete" class="del">刪除</button></div>`
            : "";
        const cls = ["msg", processing ? "processing" : "selectable", ui.selectedId === m.id ? "selected" : ""].join(" ");
        return html + `<div class="${cls}" data-id="${m.id}">${body}<span class="msg-meta">${time(m.timestamp)}${edited}${tag}</span>${actions}</div>`;
      })
      .join("");
  }

  function journalCard(j) {
    return `<button class="journal-card" data-id="${j.id}">
      ${j.mood ? `<span class="card-mood">${esc(j.mood.emoji)}</span>` : ""}
      <strong>${esc(j.result.title)}</strong>
      <span>${times(j.range)}・${STYLES[j.style]?.name || j.style}${j.mood ? `・${esc(j.mood.label)}` : ""}</span>
    </button>`;
  }

  // 手札列表：依日期分組（新的在上），同一天可以有好幾篇
  function journalList(journals) {
    if (journals.length === 0) return `<p class="empty-hint">還沒有手札喔<br>回聊天室按「一鍵整理」生成第一篇吧！</p>`;
    const sorted = [...journals].sort((a, b) => Date.parse(b.range[0]) - Date.parse(a.range[0]));
    let lastDay = "";
    return sorted
      .map((j) => {
        const day = dayLabel(j);
        const head = day !== lastDay ? `<h3 class="day-head">${day}</h3>` : "";
        lastDay = day;
        return head + journalCard(j);
      })
      .join("");
  }

  /* ---------- 手札本首頁：月曆／列表＋搜尋／心情 ---------- */
  function logicalDate(iso) {
    const d = new Date(iso);
    if (d.getHours() < 3) d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const journalDay = (j) => keyOf(logicalDate(j.range[0]));

  function byDay(journals) {
    const map = new Map();
    [...journals]
      .sort((a, b) => Date.parse(a.range[0]) - Date.parse(b.range[0]))
      .forEach((j) => map.set(journalDay(j), [...(map.get(journalDay(j)) || []), j]));
    return map;
  }

  function homeTabs(tab) {
    const tabs = [
      ["calendar", "📅 月曆"],
      ["list", "📋 列表"],
      ["mood", "📊 心情與回顧"],
    ];
    return `<div class="home-tabs">${tabs
      .map(([k, n]) => `<button class="home-tab${k === tab ? " active" : ""}" data-tab="${k}">${n}</button>`)
      .join("")}</div>`;
  }

  const monthNav = (y, m) =>
    `<div class="month-nav"><button data-month="-1" aria-label="上個月">‹</button><strong>${y} 年 ${m + 1} 月</strong><button data-month="1" aria-label="下個月">›</button></div>`;

  function calendar(journals, y, m, selectedKey) {
    const days = byDay(journals);
    const first = new Date(y, m, 1);
    const total = new Date(y, m + 1, 0).getDate();
    const todayKey = keyOf(new Date());
    let cells = WEEK.split("").map((w) => `<div class="cal-week">${w}</div>`).join("");
    cells += `<div class="cal-blank"></div>`.repeat(first.getDay());
    let count = 0;
    for (let d = 1; d <= total; d++) {
      const key = keyOf(new Date(y, m, d));
      const list = days.get(key) || [];
      count += list.length;
      const cls = ["cal-day", list.length ? "has" : "", key === todayKey ? "today" : "", key === selectedKey ? "picked" : ""].join(" ");
      const mood = list.find((j) => j.mood)?.mood;
      const inner = `<span class="cal-num">${d}</span>${list.length ? `<span class="cal-mood">${mood ? esc(mood.emoji) : "📔"}</span>` : ""}${list.length > 1 ? `<span class="cal-count">${list.length}</span>` : ""}`;
      cells += list.length ? `<button class="${cls}" data-day="${key}">${inner}</button>` : `<div class="${cls}">${inner}</div>`;
    }
    const picked = selectedKey && (days.get(selectedKey) || []).length > 1 && selectedKey.startsWith(`${y}-${pad(m + 1)}`)
      ? `<div class="cal-picked"><h3 class="day-head">${dayLabel(days.get(selectedKey)[0])} 有 ${days.get(selectedKey).length} 篇</h3>${days.get(selectedKey).map(journalCard).join("")}</div>`
      : "";
    const hint = count ? `<p class="hint cal-hint">點有圖示的日期打開手札</p>` : `<p class="empty-hint">這個月還沒有手札</p>`;
    return `${monthNav(y, m)}<div class="calendar">${cells}</div>${hint}${picked}`;
  }

  // 搜尋：比對總結、各風格的內文、原始紀錄，顯示命中的片段
  function searchResults(journals, msgMap, query) {
    const q = query.trim();
    if (!q) return journalList(journals);
    const lower = q.toLowerCase();
    const hits = [];
    [...journals]
      .sort((a, b) => Date.parse(b.range[0]) - Date.parse(a.range[0]))
      .forEach((j) => {
        const sources = [
          ["總結", j.result.title],
          ...Object.entries(j.versions || {}).flatMap(([k, v]) => v.sections.map((s) => [STYLES[k]?.name || k, s.refined_text])),
          ...j.message_ids.map((id) => msgMap.get(id)).filter((m) => m?.type === "text").map((m) => ["原始紀錄", m.content]),
        ];
        const found = sources.find(([, text]) => text.toLowerCase().includes(lower));
        if (!found) return;
        const [src, text] = found;
        const i = text.toLowerCase().indexOf(lower);
        const before = text.slice(Math.max(0, i - 18), i);
        const after = text.slice(i + q.length, i + q.length + 24);
        hits.push(`<button class="journal-card" data-id="${j.id}">
          <strong>${dayLabel(j)}　${esc(j.result.title)}</strong>
          <span class="snippet">${i > 18 ? "…" : ""}${esc(before)}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(after)}${i + q.length + 24 < text.length ? "…" : ""}</span>
          <span>在「${src}」裡找到</span>
        </button>`);
      });
    return hits.length ? `<p class="hint">找到 ${hits.length} 篇</p>${hits.join("")}` : `<p class="empty-hint">找不到「${esc(q)}」</p>`;
  }

  function searchPanel(journals, msgMap, query) {
    return `<input id="searchInput" class="search-input" type="search" placeholder="🔍 搜尋手札或原始紀錄，例如：咖哩" value="${esc(query)}">
      <div id="searchResults">${searchResults(journals, msgMap, query)}</div>`;
  }

  // 心情：這個月每天的心情分數長條圖＋常出現的心情
  const SCORE_WORD = ["", "很糟", "不太好", "普通", "不錯", "超好"];
  // 月回顧卡片。review：存好的回顧（沒有就是 undefined）；busy：正在產生
  function reviewCard(review, monthJournals, m, busy) {
    const dayBtn = (d) => {
      const [, mm, dd] = d.split("-").map(Number);
      return `<button class="review-day" data-day="${d}">${mm}/${dd}</button>`;
    };
    const list = (arr) => (arr.length ? `<ul>${arr.map((x) => `<li>${dayBtn(x.date)}${esc(x.text)}</li>`).join("")}</ul>` : `<p class="hint">沒有特別提到</p>`);
    const btnText = busy ? "⏳ 回顧產生中…" : review ? "↻ 重新產生" : "✨ 產生回顧";
    const head = `<div class="review-head"><h3>🗓️ ${m + 1} 月回顧</h3><button id="btnReview" class="ghost"${busy ? " disabled" : ""}>${btnText}</button></div>`;
    if (!review) return `<div class="review-card">${head}<p class="hint">讓 AI 讀這個月的 ${monthJournals.length} 篇手札，用你的口吻寫一篇月回顧。</p></div>`;
    const r = review.result;
    const more = monthJournals.length - review.journal_count;
    const day = (label, d) => (d ? `<p class="review-best">${label}：${dayBtn(d.date)}${esc(d.reason)}</p>` : "");
    return `<div class="review-card">${head}
      <p class="review-title">${esc(r.title)}</p>
      ${r.summary.split("\n").filter((t) => t.trim()).map((t) => `<p>${esc(t)}</p>`).join("")}
      <div class="review-cols">
        <div><h4>😆 開心的事</h4>${list(r.happy)}</div>
        <div><h4>😩 煩惱的事</h4>${list(r.annoying)}</div>
      </div>
      ${day("最棒的一天", r.best_day)}${day("最慘的一天", r.worst_day)}
      <p class="hint">根據 ${review.journal_count} 篇手札產生${more > 0 ? `・這個月又多了 ${more} 篇，可以重新產生` : ""}・點日期可以打開那天的手札</p>
    </div>`;
  }

  function moodView(journals, y, m, review, busy = false) {
    const days = byDay(journals);
    const total = new Date(y, m + 1, 0).getDate();
    const prefix = `${y}-${pad(m + 1)}`;
    const monthJournals = journals.filter((j) => journalDay(j).startsWith(prefix));
    if (!monthJournals.length) return `${monthNav(y, m)}<p class="empty-hint">這個月還沒有手札</p>`;
    const card = reviewCard(review, monthJournals, m, busy);

    const points = [];
    for (let d = 1; d <= total; d++) {
      const list = (days.get(keyOf(new Date(y, m, d))) || []).filter((j) => j.mood);
      if (list.length) {
        const score = list.reduce((n, j) => n + j.mood.score, 0) / list.length;
        points.push({ d, score, emoji: list[0].mood.emoji, label: list.map((j) => j.mood.label).join("、") });
      }
    }
    const missing = monthJournals.filter((j) => !j.mood).length;
    const fill = missing ? `<button id="btnFillMood" class="ghost fill-mood">幫這個月 ${missing} 篇還沒有心情的手札補上心情</button>` : "";
    if (!points.length) return `${monthNav(y, m)}${card}<p class="empty-hint">這個月的手札還沒有心情資料</p>${fill}`;

    const avg = points.reduce((n, p) => n + p.score, 0) / points.length;
    const recorded = new Set(monthJournals.map(journalDay)).size;

    // 長條圖：單一數列、單一顏色，柱子從基準線往上長、頂端 4px 圓角，格線淡化，滑過顯示提示
    const W = 700, H = 220, L = 30, R = 8, T = 12, B = 26;
    const pw = W - L - R, ph = H - T - B;
    const slot = pw / total;
    const bw = Math.max(4, slot - 2);
    const yOf = (v) => T + ph - (v / 5) * ph;
    let grid = "";
    for (let v = 1; v <= 5; v++) {
      grid += `<line x1="${L}" x2="${W - R}" y1="${yOf(v)}" y2="${yOf(v)}" class="mood-grid"/>`;
      if (v % 2) grid += `<text x="${L - 8}" y="${yOf(v) + 4}" class="mood-axis" text-anchor="end">${v}</text>`;
    }
    const base = yOf(0);
    let bars = "";
    points.forEach((p) => {
      const x = L + (p.d - 1) * slot + (slot - bw) / 2;
      const top = yOf(p.score);
      const r = Math.min(4, bw / 2, base - top);
      const path = `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`;
      bars += `<g class="mood-bar"><title>${m + 1}/${p.d} ${p.emoji} ${p.label}（${p.score.toFixed(1).replace(".0", "")} 分）</title>
        <rect x="${L + (p.d - 1) * slot}" y="${T}" width="${slot}" height="${ph}" class="mood-hit"/>
        <path d="${path}" class="mood-fill"/></g>`;
    });
    let xs = "";
    for (let d = 1; d <= total; d++) {
      if (d === 1 || d % 5 === 0) xs += `<text x="${L + (d - 0.5) * slot}" y="${H - 8}" class="mood-axis" text-anchor="middle">${d}</text>`;
    }
    const chart = `<svg class="mood-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${y} 年 ${m + 1} 月每天的心情分數">
      ${grid}<line x1="${L}" x2="${W - R}" y1="${base}" y2="${base}" class="mood-base"/>${bars}${xs}</svg>`;

    const tally = new Map();
    monthJournals.filter((j) => j.mood).forEach((j) => {
      const k = `${j.mood.emoji} ${j.mood.label}`;
      tally.set(k, (tally.get(k) || 0) + 1);
    });
    const tags = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, n]) => `<span class="mood-tag">${esc(k)}<b>×${n}</b></span>`)
      .join("");

    return `${monthNav(y, m)}
      ${card}
      <div class="mood-stats">
        <div class="mood-hero"><b>${avg.toFixed(1)}</b><span>平均心情・${SCORE_WORD[Math.round(avg)]}</span></div>
        <div class="mood-hero"><b>${recorded}</b><span>天有手札</span></div>
      </div>
      <h3 class="day-head">每天的心情分數（1 很糟～5 超好）</h3>
      ${chart}
      <h3 class="day-head">這個月最常出現的心情</h3>
      <div class="mood-tags">${tags}</div>
      ${fill}`;
  }

  // 匯出圖片用：只有標題和內文，沒有按鈕
  function journalExport(j, msgMap) {
    const body = j.style === "memo" ? memoBody(j, msgMap) : articleBody(j, msgMap);
    return `<div class="export-page journal-reader">
      <h2 class="reader-title">${dayLabel(j)}</h2>
      <p class="reader-summary">${esc(j.result.title)}</p>
      <p class="reader-range">${times(j.range)}・${STYLES[j.style].name}${j.mood ? `・${esc(j.mood.emoji)} ${esc(j.mood.label)}` : ""}</p>
      ${body}
      <p class="export-foot">— 忘紀 —</p>
    </div>`;
  }

  // 每一行都以「- 」開頭 → 畫成條列，否則照原樣（保留換行）
  function textBlock(t) {
    const lines = t.split("\n").filter((l) => l.trim());
    if (lines.length && lines.every((l) => l.trim().startsWith("- "))) {
      return `<ul>${lines.map((l) => `<li>${esc(l.trim().slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p>${esc(t)}</p>`;
  }

  // 風格按鈕列：current 高亮；cached 裡有的風格加上 ✓（切換免重新生成）
  function stylePicker(current, cached = []) {
    return STYLE_KEYS.map(
      (k) => `<button type="button" class="style-chip${k === current ? " active" : ""}" data-style="${k}">
        ${STYLES[k].name}${cached.includes(k) && k !== current ? `<span class="cached">✓</span>` : ""}
      </button>`
    ).join("");
  }

  const imgsOf = (s, msgMap) =>
    s.matched_images.map((id) => msgMap.get(id)).filter(Boolean);

  // 極簡備忘錄：固定三個分類（依固定順序），照片統一放在最後
  function memoBody(j, msgMap) {
    const order = (t) => (MEMO_SECTIONS.includes(t) ? MEMO_SECTIONS.indexOf(t) : 99);
    const blocks = [...j.result.sections]
      .sort((a, b) => order(a.section_title) - order(b.section_title))
      .map(
        (s) => `<section class="memo-block">
          ${s.section_title ? `<h3>${esc(s.section_title)}</h3>` : ""}
          ${textBlock(s.refined_text)}
        </section>`
      )
      .join("");
    const photos = j.message_ids
      .map((id) => msgMap.get(id))
      .filter((m) => m && m.type === "image")
      .map((m) => `<img src="${imgURL(m)}" alt="照片">`)
      .join("");
    const stks = stickersOf(j, msgMap)
      .slice(0, 5)
      .map((m) => pageSticker(m, ""))
      .join("");
    return `<div class="memo">${stks ? `<div class="memo-stickers">${stks}</div>` : ""}${blocks}${photos ? `<div class="memo-gallery">${photos}</div>` : ""}</div>`;
  }

  // 其他風格：一整篇文章，照片依時間穿插在段落旁，左右交錯
  const stickersOf = (j, msgMap) =>
    j.message_ids
      .map((id) => msgMap.get(id))
      .filter((m) => m && m.type === "sticker")
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  // 貼圖屬於哪一段：開始時間不晚於貼圖時間的最後一段（跨午夜也算得對）
  function sectionFor(ts, sections, startISO) {
    const start = new Date(startISO);
    const t = Date.parse(ts);
    let idx = 0;
    sections.forEach((s, i) => {
      const m = /^(\d{1,2}):(\d{2})/.exec(s.time_range || "");
      if (!m) return;
      const d = new Date(start);
      d.setHours(+m[1], +m[2], 0, 0);
      if (d < start - 60000) d.setDate(d.getDate() + 1);
      if (d.getTime() <= t) idx = i;
    });
    return idx;
  }

  function pageSticker(m, side) {
    const h = hash(m.id);
    const rot = (h % 2 ? 1 : -1) * (6 + (h % 9)); // 左歪或右歪 6°～14°
    return `<span class="page-sticker ${side}" style="--rot:${rot}deg">${stickerFace(m)}</span>`;
  }

  // 貼紙放在哪一段、哪一側：有手動調整（result.sticker_place）就用手動的，否則依時間自動放
  // 手動拿掉的貼紙記在 result.hidden_stickers
  function stickerLayout(j, msgMap) {
    const n = j.result.sections.length;
    const manual = j.result.sticker_place || {};
    const hidden = j.result.hidden_stickers || [];
    const sides = floatSides(j, msgMap);
    const out = new Map();
    stickersOf(j, msgMap).forEach((m) => {
      if (hidden.includes(m.id)) return;
      const s = sectionFor(m.timestamp, j.result.sections, j.range[0]);
      // 自動側邊：那段有浮動照片就放另一側，沒有就依 id 決定
      const autoSide = (sec) => (sides[sec] ? (sides[sec] === "right" ? "left" : "right") : (hash(m.id) >> 3) % 2 ? "left" : "right");
      const man = manual[m.id] && manual[m.id].s < n ? manual[m.id] : null;
      const sec = man ? man.s : s;
      out.set(m.id, { m, s: sec, side: (man && man.side) || autoSide(sec) });
    });
    return out;
  }

  // 每段浮動照片（側邊圖／拍立得）在哪一側：有這種照片的段落輪流放右、左；其他段落是 null
  function floatSides(j, msgMap) {
    let turn = 0;
    return j.result.sections.map((s) => {
      const count = imgsOf(s, msgMap).length;
      const layout = normalizeLayout(s.layout || "side", count);
      if (!count || (layout !== "side" && layout !== "polaroid")) return null;
      return turn++ % 2 ? "left" : "right";
    });
  }

  // 一段的照片依版型排：hero 大圖、side 側邊、polaroid 拍立得、pair 兩張並排、collage 拼貼
  function photoBlock(imgs, layout, side) {
    const img = (m) => `<img src="${imgURL(m)}" alt="照片">`;
    if (!imgs.length) return "";
    if (layout === "hero") return `<figure class="para-hero">${img(imgs[0])}</figure>`;
    if (layout === "pair") return `<div class="para-grid pair">${imgs.map((m) => `<figure>${img(m)}</figure>`).join("")}</div>`;
    if (layout === "collage") return `<div class="para-grid collage">${imgs.map((m) => `<figure>${img(m)}</figure>`).join("")}</div>`;
    if (layout === "polaroid") {
      return imgs.map((m) => `<figure class="para-polaroid ${side}" style="--rot:${(hash(m.id) % 2 ? 1 : -1) * (3 + (hash(m.id) % 4))}deg">${img(m)}</figure>`).join("");
    }
    return imgs.map((m) => `<figure class="para-img ${side}">${img(m)}</figure>`).join("");
  }

  function articleBody(j, msgMap) {
    const sides = floatSides(j, msgMap);
    const stickers = [...stickerLayout(j, msgMap).values()];
    const paras = j.result.sections
      .map((s, i) => {
        const imgs = imgsOf(s, msgMap);
        const layout = normalizeLayout(s.layout || "side", imgs.length);
        const stks = stickers
          .filter((x) => x.s === i)
          .map((x) => pageSticker(x.m, x.side))
          .join("");
        // 每段包成一個區塊：照片只在自己這段裡排，不會跑去夾住下一段的文字
        return `<div class="para">${photoBlock(imgs, layout, sides[i] || "right")}${stks}<p>${esc(s.refined_text)}</p></div>`;
      })
      .join("");
    return `<article class="article">${paras}<div class="clear"></div></article>`;
  }



  // 原文對照：左邊是當時隨手丟的原始紀錄，右邊是 AI 整理後的段落，依時間一段一段對齊
  function compareBody(j, msgMap) {
    const originals = j.message_ids
      .map((id) => msgMap.get(id))
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const rawItem = (m) => {
      const body =
        m.type === "image"
          ? `<img class="cmp-thumb" src="${imgURL(m)}" alt="照片">`
          : m.type === "sticker"
            ? `<span class="cmp-sticker">${stickerFace(m)}</span>`
            : esc(m.content);
      return `<div class="cmp-msg"><span class="cmp-time">${time(m.timestamp)}</span><span>${body}</span></div>`;
    };
    const rawChars = originals.filter((m) => m.type === "text").reduce((n, m) => n + m.content.length, 0);
    const newChars = j.result.sections.reduce((n, s) => n + s.refined_text.length, 0);
    const stats = `<p class="cmp-stats">原始紀錄 ${originals.length} 則、${rawChars} 字 → 整理後 ${j.result.sections.length} ${j.style === "memo" ? "個分類" : "段"}、${newChars} 字</p>`;
    const head = `<div class="cmp-row cmp-head"><div>原始紀錄</div><div>整理後（${STYLES[j.style].name}）</div></div>`;

    let rows;
    if (j.style === "memo") {
      const blocks = j.result.sections.map((s) => `<h4>${esc(s.section_title || "")}</h4>${textBlock(s.refined_text)}`).join("");
      rows = `<div class="cmp-row"><div class="cmp-raw">${originals.map(rawItem).join("")}</div><div class="cmp-new">${blocks}</div></div>`;
    } else {
      const groups = j.result.sections.map(() => []);
      originals.forEach((m) => groups[sectionFor(m.timestamp, j.result.sections, j.range[0])].push(m));
      rows = j.result.sections
        .map(
          (s, i) => `<div class="cmp-row">
            <div class="cmp-raw">${groups[i].map(rawItem).join("") || `<span class="cmp-none">（無）</span>`}</div>
            <div class="cmp-new">${textBlock(s.refined_text)}</div>
          </div>`
        )
        .join("");
    }
    return `<div class="compare">${stats}${head}${rows}</div>`;
  }

  // nav：{ prev, next } 前一篇／後一篇手札（沒有就是 null）；compare：是否顯示原文對照
  function journal(j, msgMap, nav = {}, compare = false) {
    const body = compare ? compareBody(j, msgMap) : j.style === "memo" ? memoBody(j, msgMap) : articleBody(j, msgMap);
    const navBtn = (x, dir) =>
      x
        ? `<button class="nav-turn" data-dir="${dir}">${dir === "prev" ? `← 前一篇 ${dayLabel(x)}` : `${dayLabel(x)} 後一篇 →`}</button>`
        : `<span></span>`;
    return `<div class="reader-top">
        <button class="reader-back" id="btnReaderBack">← 所有手札</button>
        <div class="reader-actions">
          <button id="btnCompare"${compare ? ' class="on"' : ""}>${compare ? "📔 看手札" : "🔍 對照原文"}</button>
          <button id="btnExport">🖼️ 匯出圖片</button>
          <button id="btnEditJournal">✏️ 編輯</button>
          <button id="btnDeleteJournal" class="del">🗑️ 刪除</button>
        </div>
      </div>
      <h2 class="reader-title">${dayLabel(j)}</h2>
      <p class="reader-summary">${esc(j.result.title)}</p>
      <p class="reader-range">${times(j.range)}${j.mood ? `・${esc(j.mood.emoji)} ${esc(j.mood.label)}` : ""}${j.result.edited ? "・已手動編輯" : ""}</p>
      <div class="reader-styles">
        <div class="label">換個風格看看（✓ 表示已生成過，切換不用等）<button class="rewrite-btn" id="btnRewrite" title="不滿意目前的版本？用同一個風格重新生成">↻ 重寫這個風格</button></div>
        <div class="style-picker" id="readerStyles">${stylePicker(j.style, Object.keys(j.versions || {}))}</div>
      </div>
      <div id="readerSections">${body}</div>
      <nav class="reader-nav" id="readerNav">${navBtn(nav.prev, "prev")}${navBtn(nav.next, "next")}</nav>`;
  }

  // 手札編輯畫面：標題＋每一段（備忘錄是每個分類）一個文字框
  // 手札編輯畫面。draft 是正在編輯的草稿（按儲存才會寫回）
  // 一整篇的風格：每段可以改文字、換照片版型、照片換段落／拿掉、看 AI 推測的照片說明（只在這裡顯示）、貼紙換段落／左右／拿掉
  function journalEditor(j, draft, msgMap) {
    const isMemo = j.style === "memo";
    const n = draft.sections.length;
    const pseudo = { ...j, result: draft };
    const stickers = isMemo ? [] : [...stickerLayout(pseudo, msgMap).values()];
    const notes = draft.photo_notes || {};
    const btn = (act, id, label, title, off = false) =>
      `<button type="button" class="mini-btn" data-act="${act}" data-id="${id}" title="${title}"${off ? " disabled" : ""}>${label}</button>`;

    const blocks = draft.sections
      .map((s, i) => {
        const label = isMemo ? s.section_title : `第 ${i + 1} 段${s.time_range ? `（${s.time_range}）` : ""}`;
        const rows = Math.min(14, Math.max(3, Math.ceil(s.refined_text.length / 32) + s.refined_text.split("\n").length));
        const text = `<textarea class="edit-section" data-i="${i}" rows="${rows}">${esc(s.refined_text)}</textarea>`;
        if (isMemo) return `<label class="edit-label">${esc(label)}${text}</label>`;

        const imgs = imgsOf(s, msgMap);
        const layouts = layoutsFor(imgs.length);
        const layout = normalizeLayout(s.layout, imgs.length);
        const layoutSel = layouts.length
          ? `<label class="edit-layout-label">照片版型
              <select class="edit-layout" data-i="${i}">${layouts.map((k) => `<option value="${k}"${k === layout ? " selected" : ""}>${LAYOUTS[k]}</option>`).join("")}</select>
            </label>`
          : "";
        const photos = imgs
          .map(
            (m) => `<div class="edit-photo">
              <img src="${imgURL(m)}" alt="照片">
              <div class="edit-photo-side">
                <input class="edit-note" data-id="${m.id}" value="${esc(notes[m.id] || "")}" placeholder="照片說明（只在編輯時看得到）">
                <div class="mini-row">
                  ${btn("img-up", m.id, "↑ 上一段", "移到上一段", i === 0)}
                  ${btn("img-down", m.id, "↓ 下一段", "移到下一段", i === n - 1)}
                  ${btn("img-hide", m.id, "拿掉", "不在手札裡顯示（原始照片還在）")}
                </div>
              </div>
            </div>`
          )
          .join("");
        const stks = stickers
          .filter((x) => x.s === i)
          .map(
            (x) => `<div class="edit-sticker">
              <span class="edit-sticker-face">${stickerFace(x.m)}</span>
              <div class="mini-row">
                ${btn("stk-up", x.m.id, "↑", "移到上一段", i === 0)}
                ${btn("stk-down", x.m.id, "↓", "移到下一段", i === n - 1)}
                ${btn("stk-side", x.m.id, x.side === "left" ? "放右邊" : "放左邊", "換到另一側")}
                ${btn("stk-hide", x.m.id, "拿掉", "不在手札裡顯示")}
              </div>
            </div>`
          )
          .join("");
        return `<div class="edit-box">
          <div class="edit-head"><span>${esc(label)}</span>${layoutSel}</div>
          ${text}
          ${photos || stks ? `<div class="edit-media">${photos}${stks ? `<div class="edit-stickers">${stks}</div>` : ""}</div>` : ""}
        </div>`;
      })
      .join("");

    // 拿掉的照片和貼紙，可以放回去
    const hiddenImgs = (draft.hidden_images || []).map((id) => msgMap.get(id)).filter(Boolean);
    const hiddenStks = (draft.hidden_stickers || []).map((id) => msgMap.get(id)).filter(Boolean);
    const hiddenArea =
      hiddenImgs.length || hiddenStks.length
        ? `<div class="edit-hidden"><span class="hint">已拿掉（點「放回」會放回時間最接近的段落）</span>
            ${hiddenImgs.map((m) => `<div class="edit-hidden-item"><img src="${imgURL(m)}" alt="照片">${btn("img-back", m.id, "放回", "放回手札")}</div>`).join("")}
            ${hiddenStks.map((m) => `<div class="edit-hidden-item"><span class="edit-sticker-face">${stickerFace(m)}</span>${btn("stk-back", m.id, "放回", "放回手札")}</div>`).join("")}
          </div>`
        : "";

    return `<div class="reader-top">
        <span class="reader-back">編輯 ${dayLabel(j)} 的手札（${STYLES[j.style].name}）</span>
      </div>
      <div class="journal-editor">
        <label class="edit-label">一句話總結
          <input id="editTitle" value="${esc(draft.title)}">
        </label>
        ${blocks}
        ${hiddenArea}
        <p class="hint">只會修改目前這個風格的版本。${isMemo ? "條列請保留每行開頭的「- 」。" : "照片說明是 AI 依前後訊息推測的，只在這裡顯示，手札上不會出現。"}</p>
        <div class="dlg-actions">
          <button id="btnEditCancel" class="ghost">取消</button>
          <button id="btnEditSave" class="primary">儲存</button>
        </div>
      </div>`;
  }


  // 貼圖面板：上排分類分頁（最近／各類表情／自己的），下面是貼圖格子，不顯示文字
  function stickerPanel(custom = [], tab = "recent") {
    const recent = recentStickers();
    const tabs = [
      { key: "recent", icon: "🕘", name: "最近使用" },
      ...STICKER_GROUPS.map((g) => ({ key: g.key, icon: g.icon, name: g.name })),
      { key: "mine", icon: "⭐", name: "自己的貼圖" },
    ]
      .map((t) => `<button type="button" class="stk-tab${t.key === tab ? " active" : ""}" data-tab="${t.key}" title="${t.name}">${t.icon}</button>`)
      .join("");

    const emojiBtn = (e) => `<button type="button" class="stk" data-emoji="${e}"><span class="stk-face">${e}</span></button>`;
    let grid;
    if (tab === "mine") {
      grid =
        custom
          .map(
            (c) => `<button type="button" class="stk" data-custom="${c.id}">
              <span class="stk-face"><img src="${imgURL({ id: `pack_${c.id}`, blob: c.blob })}" alt=""></span>
              <span class="stk-del" data-del="${c.id}" title="從貼圖庫移除">×</span>
            </button>`
          )
          .join("") +
        `<label class="stk stk-add" title="上傳自己的貼圖"><span class="stk-face">＋</span><input id="stickerUpload" type="file" accept="image/*" hidden></label>`;
    } else if (tab === "recent") {
      grid = recent.length ? recent.map(emojiBtn).join("") : `<p class="stk-empty">還沒有用過的貼圖，從上面的分類挑一個吧</p>`;
    } else {
      grid = STICKER_GROUPS.find((g) => g.key === tab).list.map(emojiBtn).join("");
    }
    return `<div class="stk-tabs">${tabs}</div><div class="stk-grid">${grid}</div>`;
  }

  // AI 品質紀錄的統計畫面
  function aiLogView(log) {
    if (!log.length) return `<p class="hint">還沒有紀錄。之後每次整理、重寫、補心情、產生月回顧都會記一筆（只記次數、原因和秒數，不記日記內容）。</p>`;
    const KIND = { journal: "一鍵整理", rewrite: "換風格／重寫", mood: "補心情", review: "月回顧" };
    const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
    const ok = log.filter((e) => e.ok);
    const first = ok.filter((e) => e.tries === 1).length;
    const avgTries = ok.length ? (ok.reduce((n, e) => n + e.tries, 0) / ok.length).toFixed(1) : "—";
    const avgSec = log.length ? (log.reduce((n, e) => n + e.ms, 0) / log.length / 1000).toFixed(1) : "—";

    const count = (arr) => {
      const m = new Map();
      arr.forEach((k) => m.set(k, (m.get(k) || 0) + 1));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const reasons = count(log.flatMap((e) => e.reasons));
    const fails = count(log.filter((e) => !e.ok).map((e) => e.fail));

    const styleRows = [...new Set(log.filter((e) => e.style).map((e) => e.style))]
      .map((k) => {
        const list = log.filter((e) => e.style === k);
        const good = list.filter((e) => e.ok);
        return `<tr><td>${STYLES[k]?.name || esc(k)}</td><td>${list.length}</td><td>${pct(good.filter((e) => e.tries === 1).length, list.length)}</td>
          <td>${good.length ? (good.reduce((n, e) => n + e.tries, 0) / good.length).toFixed(1) : "—"}</td></tr>`;
      })
      .join("");

    const recent = log
      .slice(-15)
      .reverse()
      .map((e) => {
        const d = new Date(e.t);
        return `<tr><td>${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}</td><td>${KIND[e.kind] || e.kind}</td>
          <td>${STYLES[e.style]?.name || ""}</td><td>${e.tries}</td>
          <td>${e.ok ? (e.reasons.length ? `成功（擋下：${esc(e.reasons.join("、"))}）` : "成功") : `<span class="log-fail">失敗：${esc(e.fail)}</span>`}</td>
          <td>${(e.ms / 1000).toFixed(1)}</td></tr>`;
      })
      .join("");

    const list = (arr) => (arr.length ? arr.map(([k, n]) => `<span class="mood-tag">${esc(k)}<b>×${n}</b></span>`).join("") : `<span class="hint">沒有</span>`);
    return `<div class="log-stats">
        <div class="mood-hero"><b>${log.length}</b><span>呼叫 AI 次數</span></div>
        <div class="mood-hero"><b>${pct(first, log.length)}</b><span>第一次就通過</span></div>
        <div class="mood-hero"><b>${avgTries}</b><span>成功時平均嘗試次數</span></div>
        <div class="mood-hero"><b>${avgSec}</b><span>平均秒數</span></div>
      </div>
      <h3 class="day-head">被驗證擋下的原因（之後自動重試）</h3><div class="mood-tags">${list(reasons)}</div>
      <h3 class="day-head">最後失敗的原因</h3><div class="mood-tags">${list(fails)}</div>
      ${styleRows ? `<h3 class="day-head">各風格</h3><table class="log-table"><tr><th>風格</th><th>次數</th><th>第一次就通過</th><th>平均嘗試</th></tr>${styleRows}</table>` : ""}
      <h3 class="day-head">最近 15 筆</h3>
      <table class="log-table"><tr><th>時間</th><th>類型</th><th>風格</th><th>次數</th><th>結果</th><th>秒</th></tr>${recent}</table>
      <p class="hint">只保留最近 500 筆；只記次數、原因和秒數，不記日記內容。</p>`;
  }

  // 主題選單：每個選項附一條色票
  function themeGrid(themes, current) {
    return Object.entries(themes)
      .map(
        ([k, name]) => `<button type="button" class="theme-opt${k === current ? " active" : ""}" data-key="${k}">
          <span class="swatch" data-theme="${k}"><i style="background:var(--bg)"></i><i style="background:var(--paper)"></i><i style="background:var(--accent)"></i><i style="background:var(--ink)"></i></span>
          ${name}
        </button>`
      )
      .join("");
  }

  return { chat, journalList, journal, journalEditor, stickerLayout, sectionFor, journalExport, aiLogView, homeTabs, calendar, searchPanel, searchResults, moodView, journalDay, range, stylePicker, themeGrid, stickerPanel, dayLabel };
})();
