// 貼圖：內建一組表情貼圖，也可以上傳自己的圖片當貼圖
// 每張貼圖都有「含意」label，整理時會告訴 AI（當作當下情緒的參考），手札裡則像貼紙一樣貼在段落旁
const STICKERS = [
  { key: "lol", emoji: "😂", label: "笑死" },
  { key: "cry", emoji: "😭", label: "大哭" },
  { key: "angry", emoji: "😤", label: "氣死" },
  { key: "love", emoji: "🥰", label: "好喜歡" },
  { key: "sleepy", emoji: "😴", label: "好想睡" },
  { key: "boom", emoji: "🤯", label: "崩潰" },
  { key: "tired", emoji: "😵", label: "累癱" },
  { key: "ok", emoji: "👍", label: "讚" },
  { key: "pray", emoji: "🙏", label: "拜託" },
  { key: "broke", emoji: "💸", label: "錢包在哭" },
  { key: "yum", emoji: "😋", label: "好吃" },
  { key: "coffee", emoji: "☕", label: "咖啡續命" },
  { key: "study", emoji: "📚", label: "讀書" },
  { key: "party", emoji: "🎉", label: "慶祝" },
  { key: "rain", emoji: "🌧️", label: "下雨" },
  { key: "night", emoji: "🌙", label: "晚安" },
];

const findSticker = (key) => STICKERS.find((s) => s.key === key);

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
