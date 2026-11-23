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
  function chat(msgs, journals = []) {
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
        const body = m.type === "image" ? `<img src="${imgURL(m)}" alt="照片">` : `<div class="bubble">${esc(m.content)}</div>`;
        const tag = m.journal_id === "processing" ? `<span class="tag">整理中</span>` : "";
        const cls = m.journal_id === "processing" ? "msg processing" : "msg";
        return html + `<div class="${cls}">${body}<span class="msg-meta">${time(m.timestamp)}${tag}</span></div>`;
      })
      .join("");
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
        return `${head}<button class="journal-card" data-id="${j.id}">
          <strong>${esc(j.result.title)}</strong>
          <span>${times(j.range)}・${STYLES[j.style]?.name || j.style}</span>
        </button>`;
      })
      .join("");
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
    return `<div class="memo">${blocks}${photos ? `<div class="memo-gallery">${photos}</div>` : ""}</div>`;
  }

  // 其他風格：一整篇文章，照片依時間穿插在段落旁，左右交錯
  function articleBody(j, msgMap) {
    let side = 0;
    const paras = j.result.sections
      .map((s) => {
        const figs = imgsOf(s, msgMap)
          .map((m) => `<figure class="para-img ${side++ % 2 ? "left" : "right"}"><img src="${imgURL(m)}" alt="照片"></figure>`)
          .join("");
        return `${figs}<p>${esc(s.refined_text)}</p>`;
      })
      .join("");
    return `<article class="article">${paras}<div class="clear"></div></article>`;
  }

  function journal(j, msgMap) {
    const body = j.style === "memo" ? memoBody(j, msgMap) : articleBody(j, msgMap);
    return `<button class="reader-back" id="btnReaderBack">← 所有手札</button>
      <h2 class="reader-title">${dayLabel(j)}</h2>
      <p class="reader-summary">${esc(j.result.title)}</p>
      <p class="reader-range">${times(j.range)}</p>
      <div class="reader-styles">
        <div class="label">換個風格看看（✓ 表示已生成過，切換不用等）</div>
        <div class="style-picker" id="readerStyles">${stylePicker(j.style, Object.keys(j.versions || {}))}</div>
      </div>
      <div id="readerSections">${body}</div>`;
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

  return { chat, journalList, journal, range, stylePicker, themeGrid, dayLabel };
})();
