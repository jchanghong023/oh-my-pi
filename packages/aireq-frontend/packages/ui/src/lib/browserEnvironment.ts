export interface BrowserReadableStorageLike {
  getItem(key: string): string | null;
}

export interface BrowserStorageLike extends BrowserReadableStorageLike {
  setItem(key: string, value: string): void;
}

function getLocalStorageCandidate(): unknown {
  try {
    return typeof window !== "undefined"
      ? globalThis.__ompAIReqLocalStorage
      : typeof globalThis.__ompAIReqLocalStorage !== "undefined"
        ? globalThis.__ompAIReqLocalStorage
        : undefined;
  } catch {
    return undefined;
  }
}

function isBrowserReadableStorageLike(
  storage: unknown,
): storage is BrowserReadableStorageLike {
  return (
    Boolean(storage) &&
    typeof (storage as Partial<BrowserReadableStorageLike>).getItem === "function"
  );
}

function isBrowserStorageLike(storage: unknown): storage is BrowserStorageLike {
  return (
    isBrowserReadableStorageLike(storage) &&
    typeof (storage as Partial<BrowserStorageLike>).setItem === "function"
  );
}

export function getSafeReadableLocalStorage(): BrowserReadableStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserReadableStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function getSafeLocalStorage(): BrowserStorageLike | null {
  const storage = getLocalStorageCandidate();

  if (!isBrowserStorageLike(storage)) {
    return null;
  }

  return storage;
}

export function readSafeLocalStorage(key: string): string | null {
  try {
    return getSafeReadableLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeSafeLocalStorage(key: string, value: string): void {
  try {
    getSafeLocalStorage()?.setItem(key, value);
  } catch {
    // SSR/测试环境或隐私模式下 localStorage 可能存在但不可写。
    // 写入失败不应阻断 UI 渲染，真实偏好下次仍可从 settingService 或默认值恢复。
  }
}
