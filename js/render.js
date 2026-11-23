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

  function articleBody(j, msgMap) {
    let side = 0;
    const bySection = new Map();
    stickersOf(j, msgMap).forEach((m) => {
      const i = sectionFor(m.timestamp, j.result.sections, j.range[0]);
      bySection.set(i, [...(bySection.get(i) || []), m]);
    });
    const paras = j.result.sections
      .map((s, i) => {
        const figs = imgsOf(s, msgMap)
          .map((m) => `<figure class="para-img ${side++ % 2 ? "left" : "right"}"><img src="${imgURL(m)}" alt="照片"></figure>`)
          .join("");
        // 貼紙貼在照片的另一側，看起來比較不擠
        const hasImg = figs !== "";
        const stks = (bySection.get(i) || [])
          .map((m, k) => pageSticker(m, hasImg ? ((side + k) % 2 ? "left" : "right") : (hash(m.id) >> 3) % 2 ? "left" : "right"))
          .join("");
        return `${figs}${stks}<p>${esc(s.refined_text)}</p>`;
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
          <button id="btnEditJournal">✏️ 編輯</button>
          <button id="btnDeleteJournal" class="del">🗑️ 刪除</button>
        </div>
      </div>
      <h2 class="reader-title">${dayLabel(j)}</h2>
      <p class="reader-summary">${esc(j.result.title)}</p>
      <p class="reader-range">${times(j.range)}${j.result.edited ? "・已手動編輯" : ""}</p>
      <div class="reader-styles">
        <div class="label">換個風格看看（✓ 表示已生成過，切換不用等）</div>
        <div class="style-picker" id="readerStyles">${stylePicker(j.style, Object.keys(j.versions || {}))}</div>
      </div>
      <div id="readerSections">${body}</div>
      <nav class="reader-nav" id="readerNav">${navBtn(nav.prev, "prev")}${navBtn(nav.next, "next")}</nav>`;
  }

  // 手札編輯畫面：標題＋每一段（備忘錄是每個分類）一個文字框
  function journalEditor(j) {
    const blocks = j.result.sections
      .map((s, i) => {
        const label = j.style === "memo" ? s.section_title : `第 ${i + 1} 段${s.time_range ? `（${s.time_range}）` : ""}`;
        const rows = Math.min(14, Math.max(3, Math.ceil(s.refined_text.length / 32) + s.refined_text.split("\n").length));
        return `<label class="edit-label">${esc(label)}
          <textarea class="edit-section" data-i="${i}" rows="${rows}">${esc(s.refined_text)}</textarea>
        </label>`;
      })
      .join("");
    return `<div class="reader-top">
        <span class="reader-back">編輯 ${dayLabel(j)} 的手札（${STYLES[j.style].name}）</span>
      </div>
      <div class="journal-editor">
        <label class="edit-label">一句話總結
          <input id="editTitle" value="${esc(j.result.title)}">
        </label>
        ${blocks}
        <p class="hint">只會修改目前這個風格的版本。${j.style === "memo" ? "條列請保留每行開頭的「- 」。" : ""}</p>
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

  return { chat, journalList, journal, journalEditor, range, stylePicker, themeGrid, stickerPanel, dayLabel };
})();
