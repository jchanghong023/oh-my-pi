/** Dev's copied UI storage facade. Never reads or writes the original WebGUI buckets. */
declare global {
  var __ompDevLocalStorage: Storage;
  var __ompDevSessionStorage: Storage;
}
function scopedStorage(kind: "localStorage" | "sessionStorage"): Storage {
  const prefix = `omp-dev:${location.pathname}:`;
  const source = () => window[kind];
  const keys = () => Array.from({ length: source().length }, (_, index) => source().key(index)).filter((key): key is string => !!key?.startsWith(prefix));
  return {
    get length() { return keys().length; },
    clear() { for (const key of keys()) source().removeItem(key); },
    key(index) { return keys()[index]?.slice(prefix.length) ?? null; },
    getItem(key) { return source().getItem(prefix + key); },
    setItem(key, value) { source().setItem(prefix + key, value); },
    removeItem(key) { source().removeItem(prefix + key); },
  };
}
globalThis.__ompDevLocalStorage = scopedStorage("localStorage");
globalThis.__ompDevSessionStorage = scopedStorage("sessionStorage");
export {};
