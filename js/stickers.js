// 貼圖：分類的表情貼圖（像手機鍵盤那樣），也可以上傳自己的圖片當貼圖
// 內建貼圖直接把 emoji 送給 AI（AI 看得懂 emoji）；自訂貼圖上傳時填的「含意」只給 AI 參考，畫面上不顯示
const STICKER_GROUPS = [
  {
    key: "face",
    icon: "😀",
    name: "表情",
    list: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖 😺 😹 😻 😿 🙀",
  },
  {
    key: "hand",
    icon: "👍",
    name: "手勢與人",
    list: "👍 👎 👏 🙌 🙏 🤝 👌 ✌️ 🤞 🤟 🤘 👋 💪 👀 🤷 🤦 🙆 🙅 💁 🙋 🏃 🚶 💃 🕺 🛌 🧑‍💻 🧑‍🍳 🧑‍🎓",
  },
  {
    key: "animal",
    icon: "🐶",
    name: "動物與植物",
    list: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐔 🐧 🐦 🐤 🦆 🦉 🐺 🐴 🦄 🐝 🐛 🦋 🐌 🐢 🐍 🐙 🦀 🐠 🐬 🐳 🦈 🐊 🦒 🦘 🐕 🐈 🐇 🦔 🌸 🌻 🌹 🌷 🍀 🌵 🌳 🍁 🍂",
  },
  {
    key: "food",
    icon: "🍔",
    name: "食物",
    list: "🍎 🍊 🍋 🍌 🍉 🍇 🍓 🍒 🍑 🥭 🍍 🥝 🍅 🥑 🌽 🥕 🍞 🥐 🥯 🧇 🥞 🧀 🍳 🥓 🍗 🍖 🍔 🍟 🍕 🌭 🥪 🌮 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍙 🍚 🍘 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 ☕ 🍵 🧋 🥤 🧃 🍺 🍻 🥂 🍷",
  },
  {
    key: "activity",
    icon: "⚽",
    name: "活動",
    list: "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏓 🏸 🎱 🏊 🚴 🧘 🏋️ 🎮 🎲 🧩 🎨 🎬 🎤 🎧 🎹 🎸 🎻 📚 📖 ✏️ 📝 💻 📱 📷 🎁 🎉 🎊 🎈 🎄 🎃 🏆 🥇",
  },
  {
    key: "life",
    icon: "🚗",
    name: "生活與天氣",
    list: "🏠 🏫 🏢 🏥 🏪 🚗 🚕 🚌 🚇 🚲 🛵 ✈️ 🚀 ⛵ 🗺️ 🏖️ ⛰️ 🏕️ 🌇 🌃 ☀️ 🌤️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 🌈 🌙 ⭐ 🌟 ⚡ 🔥 💧 🌊 ⏰ 💸 💰 💳 🛒 🛍️ 💊 🧸 🛁 🧹 🧺 🔑 ☂️",
  },
  {
    key: "symbol",
    icon: "❤️",
    name: "符號",
    list: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✨ 🎵 ❗ ❓ ⁉️ ‼️ ✅ ❌ ⭕ 🆗 🆒 🆕 🔔 📌 🚩",
  },
].map((g) => ({ ...g, list: g.list.split(" ") }));

const RECENT_STORAGE = "wangji_recent_stickers";
const RECENT_MAX = 24;

function recentStickers() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_STORAGE)) || [];
  } catch {
    return [];
  }
}
function pushRecent(emoji) {
  const list = [emoji, ...recentStickers().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_STORAGE, JSON.stringify(list));
}

// 自訂貼圖：縮到長邊 320px，存成 PNG 保留透明背景
function compressSticker(file, maxSide = 320) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("貼圖處理失敗"))), "image/png");
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`無法讀取「${file.name}」`));
    };
    img.src = url;
  });
}
