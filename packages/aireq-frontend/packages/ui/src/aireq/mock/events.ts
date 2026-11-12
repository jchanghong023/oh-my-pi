import type { Event } from "@zcode/rpc";

/** 阶段性前端原型的进程内事件，不创建网络连接。 */
export function createPrototypeEvent<T>() {
  const listeners = new Set<(value: T) => void>();
  const event: Event<T> = listener => {
    listeners.add(listener);
    return { dispose: () => { listeners.delete(listener); } };
  };
  return { event, fire(value: T) { for (const listener of listeners) listener(value); } };
}

export function silentPrototypeEvent<T>(): Event<T> {
  return () => ({ dispose() {} });
}

/** 不把未接入的真实能力伪装为执行成功。 */
export async function unavailablePrototypeOperation(): Promise<never> {
  throw new Error("阶段性前端原型未执行此真实操作；当前仅演示浏览器内存数据。");
}
