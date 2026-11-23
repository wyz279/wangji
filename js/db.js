// IndexedDB 讀寫：messages、journals，以及存設定用的 meta（例如連結的本機資料夾）
const DB = (() => {
  const NAME = "wangji";
  const VERSION = 2;
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(NAME, VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          ["messages", "journals"].forEach((name) => {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
          });
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function request(storeName, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const req = fn(db.transaction(storeName, mode).objectStore(storeName));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        })
    );
  }

  const getAll = (storeName) => request(storeName, "readonly", (s) => s.getAll());
  const getMeta = (key) => request("meta", "readonly", (s) => s.get(key));
  const setMeta = (key, value) => request("meta", "readwrite", (s) => s.put(value, key));
  const remove = (storeName, id) => request(storeName, "readwrite", (s) => s.delete(id));

  async function putMany(storeName, items) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      items.forEach((item) => store.put(item));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const put = (storeName, item) => putMany(storeName, [item]);

  async function clearAll() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["messages", "journals"], "readwrite");
      tx.objectStore("messages").clear();
      tx.objectStore("journals").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  return { getAll, put, putMany, clearAll, getMeta, setMeta, remove };
})();
