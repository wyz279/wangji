// 測試資料：三天份的碎碎念（前天、昨天、今天早上），照片用畫出來的示意圖代替，也夾了幾張貼圖
// 刻意保留口語、錯字、重複和離題，才測得出各風格的差別；天與天之間有睡眠空檔，可測自動切分
const SAMPLE_DAYS = [
  {
    offset: -2,
    items: [
      ["10:24", "睡到十點 爽"],
      ["10:25", "但是報告還沒動 不想面對 先不要想"],
      ["11:40", { img: "早午餐", emoji: "🥞", color: "#e8b86d" }],
      ["11:41", "早午餐的鬆餅超厚 奶油超多 熱量爆炸但我不管"],
      ["14:10", "去圖書館 結果位子全滿 傻眼 期末大家都瘋了嗎"],
      ["14:12", "只好去星巴克 一杯拿鐵150 心在淌血"],
      ["14:12", { sticker: "💸" }],
      ["14:13", { img: "拿鐵", emoji: "☕", color: "#a47551" }],
      ["16:30", "寫了兩個小時報告 寫了300字 我是廢物嗎"],
      ["16:31", "不對 是題目太難 不是我的問題"],
      ["19:05", "跟小美吃火鍋 她說她想轉系 嚇死"],
      ["19:06", { img: "火鍋", emoji: "🍲", color: "#c8553d" }],
      ["19:20", "她說資管讀得很痛苦 程式都看不懂 我懂啦 但還是覺得有點可惜"],
      ["23:50", "洗完澡才發現明天還要交機率作業 啊啊啊啊啊"],
      ["00:40", "寫完了 應該有一半是錯的 算了 睡覺", 1],
    ],
  },
  {
    offset: -1,
    items: [
      ["08:05", "早八 外面在下雨 不想出門"],
      ["08:06", "還是出門了 我好偉大"],
      ["08:40", "公車誤點 遲到十分鐘 老師看了我一眼 好可怕"],
      ["12:15", "午餐吃學餐咖哩 跟上次一樣難吃 為什麼我還要點"],
      ["12:16", { img: "學餐咖哩", emoji: "🍛", color: "#d9a441" }],
      ["13:30", "下午沒課 回宿舍躺平"],
      ["15:00", "滑手機滑了一個半小時 有點罪惡感"],
      ["15:02", "開始寫期末專題的程式 結果一直報錯 一直報錯"],
      ["17:45", "終於跑起來了!!!!! 感動到想哭"],
      ["17:45", { sticker: "🎉" }],
      ["17:46", { img: "程式跑起來了", emoji: "💻", color: "#4a6fa5" }],
      ["18:30", "想買新的褲子 但懶得出門 網購又怕尺寸不合"],
      ["21:00", "媽打電話來問期末考怎樣 我說還好 其實不太好"],
      ["21:05", "記得禮拜五前要繳宿舍費!!"],
      ["21:06", "還有洗衣精快用完了 要買"],
      ["23:30", "明天要早起 先睡了 晚安"],
      ["23:31", { sticker: "🌙" }],
    ],
  },
  {
    offset: 0,
    items: [
      ["09:10", "起床 好冷 不想離開被窩"],
      ["09:11", { sticker: "😴" }],
      ["09:30", { img: "早餐", emoji: "🍙", color: "#7fa07a" }],
      ["09:31", "便利商店飯糰配豆漿 經典組合"],
      ["10:00", "今天一定要把報告寫完 立flag"],
    ],
  },
];

// 畫一張示意照片：底色 + 大 emoji + 文字
function makePlaceholder(label, emoji, color) {
  const c = document.createElement("canvas");
  c.width = 800;
  c.height = 600;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 800, 600);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "#f5efe6");
  g.fillStyle = grad;
  g.fillRect(0, 0, 800, 600);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "200px serif";
  g.fillText(emoji, 400, 260);
  g.font = "bold 56px sans-serif";
  g.fillStyle = "rgba(40, 30, 20, 0.85)";
  g.fillText(label, 400, 480);
  return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.85));
}

// 回傳要新增的訊息陣列（未來時間的訊息會略過）
async function buildSampleMessages() {
  const now = Date.now();
  const list = [];
  let n = 0;
  for (const day of SAMPLE_DAYS) {
    for (const [hm, content, nextDay = 0] of day.items) {
      const [h, m] = hm.split(":").map(Number);
      const d = new Date();
      d.setDate(d.getDate() + day.offset + nextDay);
      d.setHours(h, m, 0, 0);
      if (d.getTime() > now) continue;
      const base = { timestamp: localISO(d), journal_id: null, sample: true };
      const suffix = `${d.getTime()}s${n++}`;
      if (typeof content === "string") {
        list.push({ ...base, id: `msg_${suffix}`, type: "text", content });
      } else if (content.sticker) {
        list.push({ ...base, id: `stk_${suffix}`, type: "sticker", emoji: content.sticker, label: "" });
      } else {
        list.push({ ...base, id: `img_${suffix}`, type: "image", blob: await makePlaceholder(content.img, content.emoji, content.color) });
      }
    }
  }
  return list;
}
