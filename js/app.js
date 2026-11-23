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

function renderChat() {
  const visible = messages.filter((m) => m.journal_id === null || m.journal_id === "processing").sort(byTime);
  const list = $("#chatList");
  list.innerHTML = Render.chat(visible, journals);
  list.scrollTop = list.scrollHeight;
  updateGenerateBtn();
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
  let style = localStorage.getItem(STYLE_STORAGE) || "daily";
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

function showJournalList() {
  showView("journal");
  const sorted = [...journals].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  $("#journalList").innerHTML = Render.journalList(sorted);
  $("#journalList").hidden = false;
  $("#journalReader").hidden = true;
}

function showJournal(id) {
  const j = journals.find((x) => x.id === id);
  if (!j) return;
  showView("journal");
  currentJournalId = id;
  const msgMap = new Map(messages.map((m) => [m.id, m]));
  const reader = $("#journalReader");
  reader.innerHTML = Render.journal(j, msgMap);
  reader.hidden = false;
  reader.scrollTop = 0;
  $("#journalList").hidden = true;
  $("#btnReaderBack").onclick = showJournalList;
  $("#readerStyles").onclick = (e) => {
    const chip = e.target.closest(".style-chip");
    if (chip && chip.dataset.style !== j.style) switchStyle(j, chip.dataset.style);
  };
}

// 手札換風格：生成過的直接切換，沒生成過的用同一批訊息重寫
async function switchStyle(j, style) {
  if (j.versions[style]) {
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
  $("#btnToJournals").addEventListener("click", showJournalList);
  $("#btnToChat").addEventListener("click", () => showView("chat"));
  $("#btnSettings").addEventListener("click", openSettings);
  $("#btnTheme").addEventListener("click", openThemePicker);
  $("#chatList").addEventListener("click", (e) => {
    const card = e.target.closest(".chat-journal");
    if (card) showJournal(card.dataset.id);
  });
  $("#journalList").addEventListener("click", (e) => {
    const card = e.target.closest(".journal-card");
    if (card) showJournal(card.dataset.id);
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
  await Sync.init().catch((e) => console.warn("[忘紀] 資料夾連結讀取失敗：", e));
  const st = Sync.status();
  if (st.linked && !st.active) toast("本機資料夾需要重新授權，到 ⚙️ 設定按「重新授權」");
  // M1 產生的舊手札沒有 versions，補上
  journals.forEach((j) => {
    if (!j.versions) j.versions = { [j.style]: j.result };
  });

  // 上次整理到一半就關掉頁面 → 解除鎖定，讓它們回到未整理
  const stuck = messages.filter((m) => m.journal_id === "processing");
  if (stuck.length) {
    stuck.forEach((m) => (m.journal_id = null));
    await DB.putMany("messages", stuck);
  }
  showView("chat");
}

init();
