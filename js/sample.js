// 測試資料：四天份的碎碎念（大前天的演唱會、前天的動物園、昨天的校園日、今天早上）
// 照片放在 assets/sample/（已縮小並去掉拍攝時間、地點等資訊）；照片前後的訊息會提到照片內容，讓 AI 能推測照片並挑版型
// 刻意保留口語、重複和離題，才測得出各風格的差別；天與天之間有睡眠空檔，可測自動分天
// photo 讀不到時（例如直接雙擊 index.html 打開，瀏覽器會擋），改用 fallback 畫一張示意圖
const SAMPLE_DAYS = [
  {
    offset: -3,
    items: [
      ["10:30", "今天是演唱會!!!!! 從早上醒來就在興奮"],
      ["10:31", "應援物檢查第三次了 應該沒漏東西吧"],
      ["12:20", "午餐隨便吃了麵包 太緊張吃不下"],
      ["15:40", "出發去新莊 捷運上一堆跟我同一團的粉絲 好有安全感"],
      ["17:05", "到 Zepp 了 門口的看板是手寫的欸 好可愛"],
      ["17:06", { photo: "concert-1.jpg", fallback: ["演唱會看板", "🎸", "#4a4a6a"] }],
      ["17:10", "排隊排超久 腳好酸"],
      ["19:58", "燈暗了 我要哭了"],
      ["19:58", { sticker: "😭" }],
      ["20:01", { photo: "concert-2.jpg", fallback: ["演唱會舞台", "🎤", "#2f6fa8"] }],
      ["20:03", "位置比想像中好 整個舞台都看得到"],
      ["22:40", "散場 喉嚨直接啞掉 但值得"],
      ["22:41", "周邊沒搶到 算了 人有來就好"],
      ["23:50", "回到家 腿在抖 明天還要早起去動物園 我到底在幹嘛"],
      ["23:51", { sticker: "😵" }],
    ],
  },
  {
    offset: -2,
    items: [
      ["08:30", "鬧鐘響三次才起來"],
      ["08:31", { sticker: "😴" }],
      ["09:40", "到動物園了 平日人好少 爽"],
      ["09:55", "企鵝館的水底窗好漂亮 從下面往上看 水一直在晃"],
      ["09:56", { photo: "zoo-1.jpg", fallback: ["水底窗", "🐧", "#5b8fc7"] }],
      ["10:30", "無尾熊全部在睡 跟昨天的我一樣"],
      ["11:45", "走到腿斷 動物園也太大了吧"],
      ["12:30", "園區的便當好貴 味道普普"],
      ["13:40", "去附近的咖啡廳躲太陽"],
      ["13:48", { photo: "drink.jpg", fallback: ["咖啡廳的飲料", "🍹", "#b84a4a"] }],
      ["13:49", "這杯的杯子上有一隻在喝酒的小熊 太可愛 好想帶回家（不行）"],
      ["13:50", "酸酸甜甜的 像紅茶加莓果"],
      ["16:20", "最後又繞回去走一圈 夕陽打在樹上 好安靜"],
      ["16:29", { photo: "zoo-2.jpg", fallback: ["傍晚的步道", "🌳", "#6b8f5b"] }],
      ["16:30", { sticker: "🥰" }],
      ["21:00", "洗完澡 今天走了兩萬步"],
      ["21:01", "報告完全沒動 明天再說"],
    ],
  },
  {
    offset: -1,
    items: [
      ["08:10", "早八 好想睡"],
      ["08:11", "還是出門了 我好偉大"],
      ["10:20", "機率論小考 完全看不懂 我寫了什麼我自己都不知道"],
      ["10:21", { sticker: "🤯" }],
      ["12:15", "午餐吃學餐咖哩 跟上次一樣難吃 為什麼我還要點"],
      ["14:00", "下午沒課 在圖書館寫報告 寫了兩個小時 300字"],
      ["16:10", "受不了了 去河堤走走 太陽快下山 雲好多"],
      ["16:17", { photo: "campus-1.jpg", fallback: ["河堤夕陽", "🌇", "#e0a458"] }],
      ["16:40", "坐在河堤發呆 什麼都不想做"],
      ["17:14", "天空整片變粉紅色!!!! 跟剛剛完全不一樣"],
      ["17:15", { photo: "campus-2.jpg", fallback: ["粉紅色的天空", "🌆", "#d98aa6"] }],
      ["17:16", "今天最好的時刻就是這幾分鐘"],
      ["18:20", "回宿舍路上看到聖誕樹點燈了 才十一月欸 會不會太早"],
      ["18:23", { photo: "christmas-tree.jpg", fallback: ["聖誕樹", "🎄", "#2f6b4a"] }],
      ["19:30", "晚餐便利商店 好窮"],
      ["19:31", { sticker: "💸" }],
      ["23:30", "明天要早起 先睡了 晚安"],
      ["23:31", { sticker: "🌙" }],
    ],
  },
  {
    offset: 0,
    items: [
      ["09:10", "起床 好冷 不想離開被窩"],
      ["09:11", { sticker: "🥶" }],
      ["09:30", "便利商店飯糰配豆漿 經典組合"],
      ["10:00", "今天一定要把報告寫完 立flag"],
    ],
  },
];

const SAMPLE_PHOTO_DIR = "assets/sample/";

// 畫一張示意照片：底色 + 大 emoji + 文字（讀不到真的照片時用）
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

// 讀 assets/sample/ 裡的照片；讀不到就回傳 null
async function loadSamplePhoto(name) {
  try {
    const res = await fetch(SAMPLE_PHOTO_DIR + name);
    if (!res.ok) return null;
    return await compressImage(await res.blob());
  } catch {
    return null;
  }
}

// 回傳 { list: 要新增的訊息, usedFallback: 有沒有照片讀不到改用示意圖 }（未來時間的訊息會略過）
async function buildSampleMessages() {
  const now = Date.now();
  const list = [];
  let usedFallback = false;
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
        let blob = await loadSamplePhoto(content.photo);
        if (!blob) {
          usedFallback = true;
          blob = await makePlaceholder(...content.fallback);
        }
        list.push({ ...base, id: `img_${suffix}`, type: "image", blob });
      }
    }
  }
  return { list, usedFallback };
}
