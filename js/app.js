// 畫面切換、事件綁定、整理流程
const KEY_STORAGE = "wangji_groq_key";
const GAP_HOURS = 4; // 睡眠空檔門檻（小時）
const SLEEP_WINDOW = [3, 7]; // 空檔要跨過凌晨 3～7 點才算睡覺
const STYLE_STORAGE = "wangji_style";
const THEME_STORAGE = "wangji_theme";
const THEMES = {
  kraft: "牛皮紙復古風",
  noir: "深夜黑金",
  nordic: "簡約日系北歐",
  sakura: "櫻花手帳",
  forest: "墨綠書房",
  ocean: "海鹽藍",
};

const $ = (sel) => document.querySelector(sel);
let messages = [];
let journals = [];
let generating = false;
let genLabel = ""; // 整理中按鈕上的進度文字
let rewriting = false;
let currentJournalId = null; // 目前正在閱讀的手札
const chatUI = { selectedId: null, editingId: null };
let customStickers = []; // 自己上傳的貼圖庫 [{ id, label, blob }] // 聊天室裡選取／編輯中的訊息

/* ---------- 小工具 ---------- */
function localISO(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const p = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${off >= 0 ? "+" : "-"}${p(off / 60)}:${p(off % 60)}`;
}
const newId = (prefix) => `${prefix}_${Date.now()}${Math.random().toString(36).slice(2, 5)}`;
const byTime = (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp);

let toastTimer;
function toast(text, onClick) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  el.classList.toggle("clickable", !!onClick);
  el.onclick = onClick ? () => { el.hidden = true; onClick(); } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), onClick ? 8000 : 4000);
}

// 打開對話框，等使用者按某個按鈕，回傳那個按鈕的 value
function ask(dialog) {
  return new Promise((resolve) => {
    dialog.querySelectorAll(".dlg-actions button[value]").forEach((btn) => {
      btn.onclick = () => dialog.close(btn.value);
    });
    dialog.onclose = () => resolve(dialog.returnValue || "cancel");
    dialog.returnValue = "";
    dialog.showModal();
  });
}

// 照片壓縮到長邊 1280px 的 JPEG（重新繪製也會順便去掉照片裡的 EXIF 資訊）
function compressImage(file, maxSide = 1280, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("壓縮失敗"))), "image/jpeg", quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`無法讀取「${file.name}」，可能是不支援的格式（例如 HEIC）`));
    };
    img.src = url;
  });
}

/* ---------- 聊天室 ---------- */
const pending = () => messages.filter((m) => m.journal_id === null);

// keepScroll：選取或編輯訊息時不要跳到最底下
function renderChat(keepScroll = false) {
  const visible = messages.filter((m) => m.journal_id === null || m.journal_id === "processing").sort(byTime);
  // 選取的訊息如果已經被拿去整理，就取消選取
  if (!visible.some((m) => m.id === chatUI.selectedId && m.journal_id === null)) chatUI.selectedId = chatUI.editingId = null;
  const list = $("#chatList");
  const top = list.scrollTop;
  const draft = $("#editInput")?.value; // 編輯到一半時畫面重畫（例如背景整理完成），保留已經打的字
  list.innerHTML = Render.chat(visible, journals, chatUI);
  list.scrollTop = keepScroll ? top : list.scrollHeight;
  updateGenerateBtn();
  const edit = $("#editInput");
  if (edit) {
    if (draft != null) edit.value = draft;
    edit.focus();
    edit.setSelectionRange(edit.value.length, edit.value.length);
  }
}

/* ---------- 修改／刪除訊息（只限還沒整理的） ---------- */
async function saveEdit() {
  const m = messages.find((x) => x.id === chatUI.editingId);
  const text = $("#editInput")?.value.trim();
  if (!m || m.journal_id !== null) return;
  if (!text) return toast("內容不能是空的，不要的話可以按刪除");
  if (text !== m.content) {
    m.content = text;
    m.edited = true;
    await DB.put("messages", m);
    Sync.message(m, messages);
  }
  chatUI.selectedId = chatUI.editingId = null;
  renderChat(true);
}

async function deleteMessage(id) {
  const m = messages.find((x) => x.id === id);
  if (!m || m.journal_id !== null) return;
  if (!confirm(m.type === "image" ? "確定要刪除這張照片嗎？" : m.type === "sticker" ? "確定要刪除這張貼圖嗎？" : "確定要刪除這則訊息嗎？")) return;
  await DB.remove("messages", id);
  messages = messages.filter((x) => x.id !== id);
  Sync.removed(m, messages);
  chatUI.selectedId = chatUI.editingId = null;
  renderChat(true);
}

function onChatClick(e) {
  const card = e.target.closest(".chat-journal");
  if (card) return showJournal(card.dataset.id);

  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "edit") chatUI.editingId = chatUI.selectedId;
  else if (act === "delete") return deleteMessage(chatUI.selectedId);
  else if (act === "save") return saveEdit();
  else if (act === "cancel") chatUI.editingId = null;
  else if (e.target.closest(".edit-box")) return; // 在編輯框裡點來點去不用處理
  else {
    // 點訊息 → 選取（再點一次取消）；點空白處 → 取消選取
    const msg = e.target.closest(".msg.selectable");
    chatUI.editingId = null;
    chatUI.selectedId = msg && msg.dataset.id !== chatUI.selectedId ? msg.dataset.id : null;
  }
  renderChat(true);
}

function updateGenerateBtn(text) {
  const btn = $("#btnGenerate");
  const n = pending().length;
  btn.disabled = generating || n === 0;
  btn.textContent = text || (generating ? genLabel || "⏳ 整理中…" : n ? `✨ 一鍵整理（${n} 則）` : "✨ 一鍵整理");
}

async function addMessage(msg) {
  await DB.put("messages", msg);
  messages.push(msg);
  Sync.message(msg, messages); // 不 await：寫檔在背景進行
}

async function sendText() {
  const input = $("#textInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  autoGrow();
  await addMessage({ id: newId("msg"), timestamp: localISO(), type: "text", content: text, journal_id: null });
  renderChat();
}

async function sendImages(files) {
  for (const file of files) {
    try {
      const blob = await compressImage(file);
      await addMessage({ id: newId("img"), timestamp: localISO(), type: "image", blob, journal_id: null });
      renderChat();
    } catch (e) {
      toast(e.message);
    }
  }
}

/* ---------- 貼圖 ---------- */
let stickerTab = recentStickers().length ? "recent" : "face";

function drawStickerPanel() {
  $("#stickerPanel").innerHTML = Render.stickerPanel(customStickers, stickerTab);
}

function toggleStickers() {
  const panel = $("#stickerPanel");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) drawStickerPanel();
}

async function sendSticker(st) {
  await addMessage({ id: newId("stk"), timestamp: localISO(), type: "sticker", journal_id: null, label: "", ...st });
  renderChat();
}

async function onStickerClick(e) {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    stickerTab = tab.dataset.tab;
    return drawStickerPanel();
  }
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    e.preventDefault();
    const c = customStickers.find((x) => x.id === del.dataset.del);
    if (!c || !confirm("從貼圖庫移除這張貼圖？（已經傳出去的不受影響）")) return;
    customStickers = customStickers.filter((x) => x.id !== c.id);
    await DB.setMeta("customStickers", customStickers);
    return drawStickerPanel();
  }
  const btn = e.target.closest(".stk");
  if (!btn || btn.classList.contains("stk-add")) return;
  if (btn.dataset.emoji) {
    pushRecent(btn.dataset.emoji);
    return sendSticker({ emoji: btn.dataset.emoji });
  }
  const c = customStickers.find((x) => x.id === btn.dataset.custom);
  if (c) sendSticker({ blob: c.blob, label: c.label, custom: true });
}

async function onStickerUpload(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const blob = await compressSticker(file);
    const label = (prompt("這張貼圖代表什麼心情或意思？（例如：累爆、好耶）\n只給 AI 整理時參考，畫面上不會顯示。") || "").trim() || "貼圖";
    customStickers.push({ id: newId("pack"), label: label.slice(0, 12), blob });
    await DB.setMeta("customStickers", customStickers);
    drawStickerPanel();
  } catch (err) {
    toast(err.message);
  }
}

function autoGrow() {
  const t = $("#textInput");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 140) + "px";
}

/* ---------- 一鍵整理 ---------- */

// 睡眠空檔 = 相隔 ≥ GAP_HOURS，而且空檔有跨過某天凌晨 SLEEP_WINDOW（3～7 點）
// 這樣白天上課好幾小時沒記錄，不會被誤判成睡覺
function isSleepGap(a, b) {
  if (b - a < GAP_HOURS * 3600 * 1000) return false;
  const day = new Date(a);
  day.setHours(0, 0, 0, 0);
  for (; day.getTime() < b; day.setDate(day.getDate() + 1)) {
    const winStart = new Date(day).setHours(SLEEP_WINDOW[0], 0, 0, 0);
    const winEnd = new Date(day).setHours(SLEEP_WINDOW[1], 0, 0, 0);
    if (winStart < b && winEnd > a) return true;
  }
  return false;
}

// 找最早一段睡眠空檔，只整理空檔之前的部分
function pickBatch(list) {
  const sorted = [...list].sort(byTime);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (isSleepGap(Date.parse(sorted[i].timestamp), Date.parse(sorted[i + 1].timestamp))) {
      return { batch: sorted.slice(0, i + 1), rest: sorted.slice(i + 1) };
    }
  }
  return { batch: sorted, rest: [] };
}

// 把未整理的紀錄依睡眠空檔切成一天一天
function splitDays(list) {
  const days = [];
  let rest = [...list].sort(byTime);
  while (rest.length) {
    const r = pickBatch(rest);
    days.push(r.batch);
    rest = r.rest;
  }
  return days;
}

async function onGenerate() {
  const key = localStorage.getItem(KEY_STORAGE);
  if (!key) {
    toast("先到設定貼上 Groq API Key 喔");
    return openSettings();
  }
  const all = [...pending()].sort(byTime);
  if (all.length === 0) return;
  if (!all.some((m) => m.type === "text")) return toast("目前只有照片，至少打一句話再整理吧");

  // 只有照片、沒有文字的那天沒辦法單獨整理 → 併到前一天（沒有前一天就併到後一天）
  const days = [];
  for (const d of splitDays(all)) {
    if (d.some((m) => m.type === "text") || days.length === 0) days.push(d);
    else days[days.length - 1].push(...d);
  }
  if (!days[0].some((m) => m.type === "text") && days.length > 1) days.splice(0, 2, [...days[0], ...days[1]]);

  // 風格選擇：預設上次用的
  let style = localStorage.getItem(STYLE_STORAGE);
  if (!STYLES[style]) style = "daily";
  const picker = $("#stylePicker");
  const drawPicker = () => (picker.innerHTML = Render.stylePicker(style));
  drawPicker();
  picker.onclick = (e) => {
    const chip = e.target.closest(".style-chip");
    if (chip) {
      style = chip.dataset.style;
      drawPicker();
    }
  };

  const multi = days.length > 1;
  const lines = days.map((d) => `・${Render.dayLabel({ range: [d[0].timestamp] })}：${d.length} 則`).join("\n");
  $("#confirmText").textContent = multi
    ? `還沒整理的紀錄有 ${days.length} 天，共 ${all.length} 則：\n${lines}`
    : `將整理 ${Render.range([all[0].timestamp, all[all.length - 1].timestamp])}，共 ${all.length} 則。`;
  $("#btnConfirmBatch").textContent = multi ? `分天整理（${days.length} 篇）` : "開始整理";
  $("#btnConfirmAll").textContent = "全部整理成一篇";
  $("#btnConfirmAll").hidden = !multi;

  const choice = await ask($("#confirmDlg"));
  if (choice === "cancel") return;
  localStorage.setItem(STYLE_STORAGE, style);
  runGeneration(choice === "all" ? [all] : days, key, style); // 不 await：在背景跑，聊天室照常可用
}

// batches：要整理的每一篇（每篇是一組訊息）。全部先鎖定，再一篇一篇生成
async function runGeneration(batches, key, style) {
  generating = true;
  const everything = batches.flat();
  everything.forEach((m) => (m.journal_id = "processing"));
  await DB.putMany("messages", everything);
  renderChat();

  const done = [];
  const failed = [];
  for (let i = 0; i < batches.length; i++) {
    const target = batches[i];
    const progress = batches.length > 1 ? `第 ${i + 1}/${batches.length} 篇` : "";
    genLabel = `⏳ 整理中…${progress ? `（${progress}）` : ""}`;
    updateGenerateBtn();
    try {
      const { result } = await Gen.generateJournal(target, style, key, (n) => {
        if (n > 1) {
          genLabel = `⏳ 整理中…（${progress ? progress + "，" : ""}第 ${n} 次嘗試）`;
          updateGenerateBtn();
        }
      });
      const journal = {
        id: newId("jnl"),
        created_at: localISO(),
        range: [target[0].timestamp, target[target.length - 1].timestamp],
        style,
        message_ids: target.map((m) => m.id),
        result,
        versions: { [style]: result }, // 各風格的結果都存著，切換時不用重新生成
        mood: Gen.validMood(result.mood), // 整天的心情（月曆和心情統計用）
      };
      await DB.put("journals", journal);
      journals.push(journal);
      target.forEach((m) => (m.journal_id = journal.id));
      await DB.putMany("messages", target);
      Sync.journal(journal, messages);
      done.push(journal);
    } catch (e) {
      console.error("[忘紀] 整理失敗：", e);
      target.forEach((m) => (m.journal_id = null));
      await DB.putMany("messages", target);
      failed.push(e.message);
      if (/API Key|額度|連不上/.test(e.message)) {
        // Key 錯、額度用完、斷網 → 後面幾篇也會失敗，直接全部退回
        batches.slice(i + 1).flat().forEach((m) => (m.journal_id = null));
        await DB.putMany("messages", batches.slice(i + 1).flat());
        break;
      }
    }
    renderChat();
  }

  generating = false;
  genLabel = "";
  renderChat();
  if (done.length && !failed.length) {
    const open = done.length === 1 ? () => showJournal(done[0].id) : showJournalList;
    toast(done.length === 1 ? "手札完成！點這裡查看" : `${done.length} 篇手札都完成了！點這裡查看`, open);
  } else if (done.length) {
    toast(`完成 ${done.length} 篇，有幾篇失敗：${failed[0]}（失敗的紀錄已退回，可以再按一次）`, showJournalList);
  } else {
    toast(`整理失敗：${failed[0]}`);
  }
}

/* ---------- 手札本 ---------- */
function showView(name) {
  currentJournalId = null;
  $("#chatView").hidden = name !== "chat";
  $("#journalView").hidden = name !== "journal";
  $("#btnToChat").hidden = name === "chat";
  $("#btnToJournals").hidden = name === "journal";
  if (name === "chat") renderChat();
}

// 手札本首頁的狀態：分頁、正在看的月份、月曆上點選的日期、搜尋字
const home = { tab: "calendar", y: new Date().getFullYear(), m: new Date().getMonth(), picked: null, query: "" };

function showJournalList() {
  showView("journal");
  renderHome();
  $("#journalList").hidden = false;
  $("#journalReader").hidden = true;
}

function renderHome() {
  const msgMap = new Map(messages.map((m) => [m.id, m]));
  const panel =
    home.tab === "calendar"
      ? Render.calendar(journals, home.y, home.m, home.picked)
      : home.tab === "list"
        ? Render.searchPanel(journals, msgMap, home.query)
        : Render.moodView(journals, home.y, home.m);
  $("#journalList").innerHTML = Render.homeTabs(home.tab) + `<div class="home-panel">${panel}</div>`;
}

function onHomeClick(e) {
  const tab = e.target.closest("[data-tab]");
  if (tab) {
    home.tab = tab.dataset.tab;
    return renderHome();
  }
  const mon = e.target.closest("[data-month]");
  if (mon) {
    const d = new Date(home.y, home.m + Number(mon.dataset.month), 1);
    home.y = d.getFullYear();
    home.m = d.getMonth();
    home.picked = null;
    return renderHome();
  }
  const day = e.target.closest("[data-day]");
  if (day) {
    const list = journals.filter((j) => Render.journalDay(j) === day.dataset.day);
    if (list.length === 1) return showJournal(list[0].id);
    home.picked = day.dataset.day;
    return renderHome();
  }
  if (e.target.closest("#btnFillMood")) return fillMoods();
  const card = e.target.closest(".journal-card");
  if (card) showJournal(card.dataset.id);
}

// 舊手札補心情：一篇一篇問 AI
async function fillMoods() {
  const key = localStorage.getItem(KEY_STORAGE);
  if (!key) return toast("先到設定貼上 Groq API Key 喔");
  const prefix = `${home.y}-${String(home.m + 1).padStart(2, "0")}`;
  const todo = journals.filter((j) => !j.mood && Render.journalDay(j).startsWith(prefix));
  const btn = $("#btnFillMood");
  const msgMap = new Map(messages.map((m) => [m.id, m]));
  let done = 0;
  for (const j of todo) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = `補心情中…（${done + 1}/${todo.length}）`;
    }
    try {
      const msgs = j.message_ids.map((id) => msgMap.get(id)).filter(Boolean).sort(byTime);
      const mood = await Gen.generateMood(msgs, key);
      if (mood) {
        j.mood = mood;
        await DB.put("journals", j);
        Sync.journal(j, messages);
        done++;
      }
    } catch (e) {
      toast(`補心情失敗：${e.message}`);
      break;
    }
  }
  if (home.tab === "mood" && !$("#journalList").hidden) renderHome();
  toast(`已補上 ${done} 篇的心情`);
}

/* ---------- 匯出圖片 ---------- */
// 需要時才從網路載入 html2canvas（把網頁畫成圖片的工具）
function loadHtml2canvas() {
  if (window.html2canvas) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
    sc.onload = resolve;
    sc.onerror = () => reject(new Error("載入匯出工具失敗，請確認有網路"));
    document.head.appendChild(sc);
  });
}

async function exportImage(j) {
  const btn = $("#btnExport");
  btn.disabled = true;
  btn.textContent = "⏳ 匯出中…";
  const holder = document.createElement("div");
  holder.className = "export-holder";
  try {
    await loadHtml2canvas();
    holder.innerHTML = Render.journalExport(j, new Map(messages.map((m) => [m.id, m])));
    document.body.appendChild(holder);
    const page = holder.firstElementChild;
    await Promise.all([...page.querySelectorAll("img")].map((img) => (img.complete ? null : new Promise((r) => (img.onload = img.onerror = r)))));
    const canvas = await window.html2canvas(page, {
      scale: 2,
      backgroundColor: getComputedStyle(document.body).getPropertyValue("--bg").trim() || "#ffffff",
      useCORS: true,
    });
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `忘紀_${Render.journalDay(j)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("已匯出圖片，請看瀏覽器的下載");
  } catch (e) {
    console.error("[忘紀] 匯出失敗：", e);
    toast(`匯出失敗：${e.message}`);
  } finally {
    holder.remove();
    btn.disabled = false;
    btn.textContent = "🖼️ 匯出圖片";
  }
}

// 依日期由舊到新排的手札，用來找前一篇／後一篇
const journalOrder = () => [...journals].sort((a, b) => Date.parse(a.range[0]) - Date.parse(b.range[0]));
function neighbors(id) {
  const list = journalOrder();
  const i = list.findIndex((x) => x.id === id);
  return { prev: list[i - 1] || null, next: list[i + 1] || null };
}

// 打開一篇手札。compare：是否顯示原文對照
function showJournal(id, compare = false) {
  const j = journals.find((x) => x.id === id);
  if (!j) return;
  const reader = $("#journalReader");
  showView("journal");
  currentJournalId = id;
  const msgMap = new Map(messages.map((m) => [m.id, m]));
  reader.onclick = null; // 清掉編輯模式的點擊處理
  reader.innerHTML = Render.journal(j, msgMap, neighbors(id), compare);
  reader.hidden = false;
  reader.scrollTop = 0;
  $("#journalList").hidden = true;
  $("#btnReaderBack").onclick = showJournalList;
  $("#readerStyles").onclick = (e) => {
    const chip = e.target.closest(".style-chip");
    if (chip && chip.dataset.style !== j.style) switchStyle(j, chip.dataset.style);
  };
  $("#readerNav").onclick = (e) => {
    const btn = e.target.closest(".nav-turn");
    if (btn) turnTo(btn.dataset.dir);
  };
  $("#btnCompare").onclick = () => {
    const top = reader.scrollTop;
    showJournal(j.id, !compare);
    reader.scrollTop = top;
  };
  $("#btnRewrite").onclick = () => {
    if (j.result.edited && !confirm("這個版本有手動編輯過，重寫會蓋掉你的修改，確定嗎？")) return;
    switchStyle(j, j.style, true);
  };
  $("#btnExport").onclick = () => exportImage(j);
  $("#btnEditJournal").onclick = () => editJournal(j);
  $("#btnDeleteJournal").onclick = () => deleteJournal(j);
}

/* ---------- 手札編輯／刪除 ---------- */
function editJournal(j) {
  if (rewriting) return toast("正在重寫風格，等一下再編輯");
  const reader = $("#journalReader");
  const msgMap = new Map(messages.map((m) => [m.id, m]));
  // 草稿：深拷貝目前版本，按儲存才寫回
  const draft = JSON.parse(JSON.stringify(j.result));
  draft.photo_notes = draft.photo_notes || {};
  draft.sticker_place = draft.sticker_place || {};
  draft.hidden_images = draft.hidden_images || [];
  draft.hidden_stickers = draft.hidden_stickers || [];

  // 重畫前先把輸入框裡的字收進草稿，才不會因為按了按鈕就把打到一半的字弄丟
  const collect = () => {
    draft.title = $("#editTitle").value;
    reader.querySelectorAll(".edit-section").forEach((t) => (draft.sections[t.dataset.i].refined_text = t.value));
    reader.querySelectorAll(".edit-note").forEach((t) => (draft.photo_notes[t.dataset.id] = t.value.trim()));
    reader.querySelectorAll(".edit-layout").forEach((sel) => (draft.sections[sel.dataset.i].layout = sel.value));
  };
  const draw = () => {
    const top = reader.scrollTop;
    reader.innerHTML = Render.journalEditor(j, draft, msgMap);
    reader.scrollTop = top;
  };
  const sectionOfImg = (id) => draft.sections.findIndex((s) => s.matched_images.includes(id));
  const moveImg = (id, to) => {
    const from = sectionOfImg(id);
    if (from < 0 || to < 0 || to >= draft.sections.length) return;
    draft.sections[from].matched_images = draft.sections[from].matched_images.filter((x) => x !== id);
    draft.sections[to].matched_images.push(id);
  };
  const stickerPos = (id) => Render.stickerLayout({ ...j, result: draft }, msgMap).get(id);

  draw();
  reader.scrollTop = 0;
  reader.onclick = async (e) => {
    const b = e.target.closest("[data-act]");
    if (b) {
      collect();
      const id = b.dataset.id;
      const act = b.dataset.act;
      if (act === "img-up") moveImg(id, sectionOfImg(id) - 1);
      if (act === "img-down") moveImg(id, sectionOfImg(id) + 1);
      if (act === "img-hide") {
        const i = sectionOfImg(id);
        draft.sections[i].matched_images = draft.sections[i].matched_images.filter((x) => x !== id);
        draft.hidden_images.push(id);
      }
      if (act === "img-back") {
        draft.hidden_images = draft.hidden_images.filter((x) => x !== id);
        draft.sections[Render.sectionFor(msgMap.get(id).timestamp, draft.sections, j.range[0])].matched_images.push(id);
      }
      if (act === "stk-up" || act === "stk-down" || act === "stk-side") {
        const pos = stickerPos(id);
        const place = { s: pos.s, side: pos.side };
        if (act === "stk-up") place.s = Math.max(0, pos.s - 1);
        if (act === "stk-down") place.s = Math.min(draft.sections.length - 1, pos.s + 1);
        if (act === "stk-side") place.side = pos.side === "left" ? "right" : "left";
        draft.sticker_place[id] = place;
      }
      if (act === "stk-hide") draft.hidden_stickers.push(id);
      if (act === "stk-back") draft.hidden_stickers = draft.hidden_stickers.filter((x) => x !== id);
      // 版型要跟著照片張數變
      draft.sections.forEach((s) => (s.layout = normalizeLayout(s.layout, s.matched_images.length)));
      return draw();
    }
    if (e.target.id === "btnEditCancel") return showJournal(j.id);
    if (e.target.id === "btnEditSave") {
      collect();
      draft.title = draft.title.trim();
      draft.sections.forEach((s) => (s.refined_text = s.refined_text.trim()));
      if (!draft.title) return toast("總結不能是空的");
      if (draft.sections.some((s) => !s.refined_text)) return toast("有段落是空的，不要的內容請刪掉文字但至少留一句");
      draft.edited = true;
      j.result = draft;
      j.versions[j.style] = draft;
      await DB.put("journals", j);
      Sync.journal(j, messages);
      reader.onclick = null;
      showJournal(j.id);
      toast("已儲存修改");
    }
  };
}

// 刪除手札：連同它整理的原始紀錄（文字、照片、貼圖）一起刪掉，無法復原
async function deleteJournal(j) {
  const gone = messages.filter((m) => m.journal_id === j.id);
  const ok = confirm(
    `確定要刪除 ${Render.dayLabel(j)} 這篇手札嗎？\n\n` +
      `刪除後無法復原，這篇手札整理的 ${gone.length} 則原始紀錄（包含照片和貼圖）也會一起刪除，不會回到聊天室。`
  );
  if (!ok) return;
  await DB.remove("journals", j.id);
  for (const m of gone) await DB.remove("messages", m.id);
  journals = journals.filter((x) => x.id !== j.id);
  const goneIds = new Set(gone.map((m) => m.id));
  messages = messages.filter((m) => !goneIds.has(m.id));
  Sync.journalRemoved(j);
  Sync.removedMany(gone, messages);
  showJournalList();
  toast("已刪除這篇手札和它的原始紀錄");
}

function turnTo(dir) {
  if (!currentJournalId) return;
  const target = neighbors(currentJournalId)[dir];
  if (target) showJournal(target.id);
  else toast(dir === "prev" ? "這是最早的一篇了" : "這是最新的一篇了");
}

// 手札換風格：生成過的直接切換，沒生成過的用同一批訊息重寫；force＝不管有沒有生成過都重寫
async function switchStyle(j, style, force = false) {
  if (j.versions[style] && !force) {
    j.style = style;
    j.result = j.versions[style];
    await DB.put("journals", j);
    Sync.journal(j, messages);
    return showJournal(j.id);
  }
  const key = localStorage.getItem(KEY_STORAGE);
  if (!key) return toast("先到設定貼上 Groq API Key 喔");
  if (rewriting) return toast("正在重寫另一個風格，等一下喔");

  const msgMap = new Map(messages.map((m) => [m.id, m]));
  const msgs = j.message_ids.map((id) => msgMap.get(id)).filter(Boolean).sort(byTime);
  rewriting = true;
  $("#readerSections").classList.add("rewriting");
  toast(`用「${STYLES[style].name}」重寫中…`);
  try {
    const { result } = await Gen.generateJournal(msgs, style, key);
    j.versions[style] = result;
    if (!j.mood) j.mood = Gen.validMood(result.mood);
    j.style = style;
    j.result = result;
    await DB.put("journals", j);
    Sync.journal(j, messages);
    toast(`已換成「${STYLES[style].name}」`);
  } catch (e) {
    console.error("[忘紀] 重寫失敗：", e);
    toast(`重寫失敗：${e.message}`);
  }
  rewriting = false;
  // 使用者可能已經離開這篇，只有還停在這篇時才重畫
  if (currentJournalId === j.id) showJournal(j.id);
}

/* ---------- 畫面主題 ---------- */
function applyTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE, theme);
}

// 主題選單：點選項立刻套用（可以邊看邊選），按完成關閉
function openThemePicker() {
  const grid = $("#themeGrid");
  const draw = () => (grid.innerHTML = Render.themeGrid(THEMES, document.body.dataset.theme));
  draw();
  grid.onclick = (e) => {
    const opt = e.target.closest(".theme-opt");
    if (opt) {
      applyTheme(opt.dataset.key);
      draw();
    }
  };
  ask($("#themeDlg"));
}

/* ---------- 聊天室背景 ---------- */
let bgURL = null;
function applyChatBg(blob) {
  const list = $("#chatList");
  if (bgURL) URL.revokeObjectURL(bgURL);
  bgURL = blob ? URL.createObjectURL(blob) : null;
  list.style.backgroundImage = bgURL ? `url("${bgURL}")` : "";
  list.classList.toggle("has-bg", !!blob);
}

/* ---------- 設定 ---------- */
const tail = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "");

async function openSettings() {
  const input = $("#keyInput");
  const status = $("#keyStatus");
  const saved = localStorage.getItem(KEY_STORAGE) || "";
  input.value = saved;
  status.textContent = saved ? `目前儲存的 Key：${tail(saved)}（可以對照 Groq 後台的末四碼）` : "尚未設定 Key";

  $("#btnTestKey").onclick = async () => {
    const key = input.value.trim();
    if (!key) return (status.textContent = "請先貼上 Key");
    status.textContent = `測試 ${tail(key)} 中…`;
    try {
      await Gen.testKey(key);
      status.textContent = `✅ ${tail(key)} 可以用`;
    } catch (e) {
      status.textContent = `❌ ${tail(key)}：${e.message}`;
    }
  };

  const drawFolder = () => {
    const st = Sync.status();
    $("#folderSync").hidden = !st.supported;
    if (!st.supported) return;
    $("#folderStatus").textContent = !st.linked
      ? "尚未連結。建議選專案裡的 data 資料夾。"
      : st.active
        ? `✅ 已連結「${st.name}」，自動同步中`
        : `已連結「${st.name}」，瀏覽器需要你重新授權`;
    $("#btnLinkFolder").textContent = st.linked && !st.active ? "重新授權" : st.linked ? "換一個資料夾" : "連結資料夾";
    $("#btnResync").hidden = !st.active;
  };
  drawFolder();

  $("#btnLinkFolder").onclick = async () => {
    const st = Sync.status();
    try {
      if (st.linked && !st.active) await Sync.reconnect();
      else await Sync.link();
    } catch (e) {
      if (e.name !== "AbortError") toast(`無法連結資料夾：${e.message}`);
      return drawFolder();
    }
    drawFolder();
    if (Sync.status().active) {
      $("#folderStatus").textContent = "同步中…";
      const ok = await Sync.all(messages, journals);
      drawFolder();
      toast(ok ? "已把所有紀錄和手札寫進資料夾" : "有些檔案寫入失敗，請再按一次重新同步");
    }
  };

  $("#btnResync").onclick = async () => {
    $("#folderStatus").textContent = "同步中…";
    const ok = await Sync.all(messages, journals);
    drawFolder();
    toast(ok ? "已重新同步所有檔案" : "有些檔案寫入失敗，請再試一次");
  };

  $("#bgInput").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const blob = await compressImage(file, 1920, 0.85);
      await DB.setMeta("chatBg", blob);
      applyChatBg(blob);
      toast("已換上新的聊天室背景");
    } catch (err) {
      toast(err.message);
    }
  };
  $("#btnBgRemove").onclick = async () => {
    await DB.setMeta("chatBg", null);
    applyChatBg(null);
    toast("已移除聊天室背景");
  };

  $("#btnSample").onclick = async () => {
    if (messages.some((m) => m.sample)) return (status.textContent = "測試資料已經載入過了，要重來請先清除所有紀錄");
    const sample = await buildSampleMessages();
    await DB.putMany("messages", sample);
    messages.push(...sample);
    Sync.all(messages, journals);
    $("#settingsDlg").close("cancel");
    showView("chat");
    toast(`已載入 ${sample.length} 則測試紀錄，按「一鍵整理」試試看`);
  };

  $("#btnClearAll").onclick = async () => {
    if (!confirm("確定要清除所有紀錄和手札嗎？這個動作無法復原。")) return;
    await DB.clearAll();
    messages = [];
    journals = [];
    $("#settingsDlg").close("cancel");
    showView("chat");
    toast("已清除所有資料");
  };

  if ((await ask($("#settingsDlg"))) === "save") {
    const key = input.value.trim();
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
    toast(key ? "已儲存 API Key" : "已清除 API Key");
  }
}

/* ---------- 啟動 ---------- */
function bind() {
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendText();
  });
  $("#textInput").addEventListener("keydown", (e) => {
    // Enter 送出、Shift+Enter 換行；中文選字中（isComposing）按 Enter 不送出
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendText();
    }
  });
  $("#textInput").addEventListener("input", autoGrow);
  $("#imageInput").addEventListener("change", (e) => {
    sendImages([...e.target.files]);
    e.target.value = "";
  });
  $("#btnGenerate").addEventListener("click", onGenerate);
  $("#btnStickers").addEventListener("click", toggleStickers);
  $("#stickerPanel").addEventListener("click", onStickerClick);
  $("#stickerPanel").addEventListener("change", (e) => {
    if (e.target.id === "stickerUpload") onStickerUpload(e);
  });
  $("#btnToJournals").addEventListener("click", showJournalList);
  $("#btnToChat").addEventListener("click", () => showView("chat"));
  $("#btnLogo").addEventListener("click", () => showView("chat")); // 點左上角「忘紀」回聊天室
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnTheme").addEventListener("click", openThemePicker);
  $("#chatList").addEventListener("click", onChatClick);
  $("#chatList").addEventListener("keydown", (e) => {
    if (e.target.id !== "editInput") return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === "Escape") {
      chatUI.editingId = null;
      renderChat(true);
    }
  });
  // 手札閱讀頁：鍵盤左右鍵翻頁
  document.addEventListener("keydown", (e) => {
    if (!currentJournalId || document.querySelector("dialog[open]") || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") turnTo("prev");
    if (e.key === "ArrowRight") turnTo("next");
  });
  $("#journalList").addEventListener("click", onHomeClick);
  // 搜尋：只重畫結果，輸入框不會失去焦點
  $("#journalList").addEventListener("input", (e) => {
    if (e.target.id !== "searchInput") return;
    home.query = e.target.value;
    $("#searchResults").innerHTML = Render.searchResults(journals, new Map(messages.map((m) => [m.id, m])), home.query);
  });
}

async function init() {
  const savedTheme = localStorage.getItem(THEME_STORAGE);
  if (THEMES[savedTheme]) document.body.dataset.theme = savedTheme;
  bind();
  try {
    messages = await DB.getAll("messages");
    journals = await DB.getAll("journals");
  } catch {
    toast("瀏覽器資料庫無法使用，請改用 Live Server 開啟");
  }
  customStickers = (await DB.getMeta("customStickers").catch(() => null)) || [];
  applyChatBg((await DB.getMeta("chatBg").catch(() => null)) || null);
  await Sync.init().catch((e) => console.warn("[忘紀] 資料夾連結讀取失敗：", e));
  const st = Sync.status();
  if (st.linked && !st.active) toast("本機資料夾需要重新授權，到 ⚙️ 設定按「重新授權」");
  // 整理舊手札：M1 的沒有 versions 要補上；已經拿掉的風格（例如毒舌、寫給未來）把那個版本移除
  const fixed = [];
  journals.forEach((j) => {
    let changed = false;
    if (!j.versions) {
      j.versions = { [j.style]: j.result };
      changed = true;
    }
    Object.keys(j.versions).forEach((k) => {
      if (!STYLES[k]) {
        delete j.versions[k];
        changed = true;
      }
    });
    if (!STYLES[j.style]) {
      const keep = Object.keys(j.versions)[0];
      j.style = keep || "daily";
      if (keep) j.result = j.versions[keep];
      else j.versions = { daily: j.result }; // 只剩被拿掉的風格：內容保留，標成順稿
      changed = true;
    }
    if (changed) fixed.push(j);
  });
  if (fixed.length) await DB.putMany("journals", fixed);

  // 上次整理到一半就關掉頁面 → 解除鎖定，讓它們回到未整理
  const stuck = messages.filter((m) => m.journal_id === "processing");
  if (stuck.length) {
    stuck.forEach((m) => (m.journal_id = null));
    await DB.putMany("messages", stuck);
  }
  showView("chat");
}

init();
