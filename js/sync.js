// 本機資料夾同步（File System Access API，Edge / Chrome 支援）
// 連結一個資料夾後自動維持：
//   raw/YYYY-MM-DD.json      當天的原始訊息（只放原話，不含整理狀態）
//   raw/images/<id>.jpg      上傳的照片
//   journals/YYYY-MM-DD_HHmm.json / .md   整理後的手札（JSON 完整資料＋Markdown 方便閱讀）
const Sync = (() => {
  const supported = typeof window.showDirectoryPicker === "function";
  let root = null; // 使用者選的資料夾
  let active = false; // 有權限可以寫入
  let warned = false;

  const pad = (n) => String(n).padStart(2, "0");

  // 屬於哪一天：凌晨 3 點前算前一天（和手札的日期規則一致）
  function dayKey(iso) {
    const d = new Date(iso);
    if (d.getHours() < 3) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const hhmm = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getHours())}${pad(d.getMinutes())}`;
  };
  const journalName = (j) => `${dayKey(j.range[0])}_${hhmm(j.range[0])}`;

  async function dir(parent, name) {
    return parent.getDirectoryHandle(name, { create: true });
  }
  async function writeFile(folder, name, data) {
    const fh = await folder.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
  async function exists(folder, name) {
    try {
      await folder.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  // 任何同步失敗都不影響網站本身，只提示一次
  async function safe(fn) {
    if (!active) return;
    try {
      await fn();
    } catch (e) {
      console.warn("[忘紀] 資料夾同步失敗：", e);
      if (!warned) {
        warned = true;
        toast("寫入本機資料夾失敗，到設定按「重新同步全部」再試一次");
      }
    }
  }

  /* ---------- 原始資料 ---------- */
  async function writeRawDay(key, allMessages) {
    const rawDir = await dir(root, "raw");
    const imgDir = await dir(rawDir, "images");
    const items = allMessages.filter((m) => dayKey(m.timestamp) === key).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    for (const m of items) {
      if (m.type === "image" && !(await exists(imgDir, `${m.id}.jpg`))) await writeFile(imgDir, `${m.id}.jpg`, m.blob);
    }
    const data = items.map((m) =>
      m.type === "image"
        ? { id: m.id, timestamp: m.timestamp, type: "image", file: `images/${m.id}.jpg` }
        : { id: m.id, timestamp: m.timestamp, type: "text", content: m.content }
    );
    await writeFile(rawDir, `${key}.json`, JSON.stringify({ date: key, messages: data }, null, 2));
  }

  /* ---------- 整理後的資料 ---------- */
  function toMarkdown(j, msgMap) {
    const img = (id) => `![照片](../raw/images/${id}.jpg)`;
    const lines = [`# ${Render.dayLabel(j)}`, "", `> ${j.result.title}`, "", `${STYLES[j.style].name}・原始紀錄 ${hhmm(j.range[0])}～${hhmm(j.range[1])}`, ""];
    if (j.style === "memo") {
      const order = (t) => (MEMO_SECTIONS.includes(t) ? MEMO_SECTIONS.indexOf(t) : 99);
      [...j.result.sections]
        .sort((a, b) => order(a.section_title) - order(b.section_title))
        .forEach((s) => lines.push(`## ${s.section_title}`, "", s.refined_text, ""));
      const photos = j.message_ids.filter((id) => msgMap.get(id)?.type === "image");
      if (photos.length) lines.push("## 照片", "", ...photos.map(img), "");
    } else {
      j.result.sections.forEach((s) => {
        s.matched_images.forEach((id) => lines.push(img(id), ""));
        lines.push(s.refined_text, "");
      });
    }
    return lines.join("\n");
  }

  async function writeJournal(j, allMessages) {
    const jDir = await dir(root, "journals");
    const msgMap = new Map(allMessages.map((m) => [m.id, m]));
    const name = journalName(j);
    await writeFile(jDir, `${name}.json`, JSON.stringify(j, null, 2));
    await writeFile(jDir, `${name}.md`, toMarkdown(j, msgMap));
  }

  /* ---------- 對外 ---------- */
  async function init() {
    if (!supported) return;
    root = (await DB.getMeta("folder").catch(() => null)) || null;
    if (root) active = (await root.queryPermission({ mode: "readwrite" })) === "granted";
  }

  // 一定要在使用者點按鈕時呼叫（瀏覽器規定）
  async function link() {
    root = await window.showDirectoryPicker({ mode: "readwrite", id: "wangji-data" });
    await DB.setMeta("folder", root);
    active = true;
    warned = false;
  }

  async function reconnect() {
    if (!root) return false;
    active = (await root.requestPermission({ mode: "readwrite" })) === "granted";
    warned = false;
    return active;
  }

  function status() {
    if (!supported) return { supported: false };
    return { supported: true, linked: !!root, active, name: root?.name };
  }

  const message = (msg, allMessages) => safe(() => writeRawDay(dayKey(msg.timestamp), allMessages));
  const journal = (j, allMessages) => safe(() => writeJournal(j, allMessages));

  async function all(allMessages, allJournals) {
    let ok = true;
    warned = false;
    await safe(async () => {
      const days = [...new Set(allMessages.map((m) => dayKey(m.timestamp)))];
      for (const key of days) await writeRawDay(key, allMessages);
      for (const j of allJournals) await writeJournal(j, allMessages);
    }).catch(() => (ok = false));
    return ok && !warned;
  }

  return { init, link, reconnect, status, message, journal, all };
})();
