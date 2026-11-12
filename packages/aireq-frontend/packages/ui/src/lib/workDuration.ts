/**
 * 「工作了 1 分 42 秒」的时长写法（`chat.history.workedFor`），从 `ConversationTurnGroup` 抽出，
 * 好让工作流完成卡的「时间」格与轮头的折叠标签
 * 一字不差：同一段时间在两处必须写成同一个样子。
 *
 * 规则：秒向最近取整、至少 1 秒；天 / 时 / 分 / 秒里只写非零的，**最多两段**（`1 时 3 分`，
 * 不写秒）；中文单位前留一个空格。
 */
type FormatMessage = (descriptor: { id: string }) => string;

interface WorkDurationPart {
  value: number;
  /** 中文单位词（`分` / `秒`）。 */
  unit: string;
}

const UNIT_IDS = {
  day: "chat.history.duration.day",
  hour: "chat.history.duration.hour",
  minute: "chat.history.duration.minute",
  second: "chat.history.duration.second",
} as const;

/** 拆成 `[{value, unit}]`，给要把数字与单位分开排的地方（完成卡的大数字）。 */
export function workDurationParts(
  durationMs: number,
  formatMessage: FormatMessage,
): WorkDurationPart[] {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: WorkDurationPart[] = [];
  if (days > 0) parts.push({ value: days, unit: formatMessage({ id: UNIT_IDS.day }) });
  if (hours > 0) parts.push({ value: hours, unit: formatMessage({ id: UNIT_IDS.hour }) });
  if (minutes > 0) parts.push({ value: minutes, unit: formatMessage({ id: UNIT_IDS.minute }) });
  if (seconds > 0 || parts.length === 0) {
    parts.push({ value: seconds, unit: formatMessage({ id: UNIT_IDS.second }) });
  }
  return parts.slice(0, 2);
}

/** Round before splitting so a minute never renders with 60.0 seconds. */
export function formatRunningWorkDuration(
  durationMs: number,
  formatMessage: FormatMessage,
): string {
  const tenths = Math.max(0, Math.round(durationMs / 100));
  const hours = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const seconds = (tenths % 600) / 10;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} ${formatMessage({ id: UNIT_IDS.hour })}`);
  if (hours || minutes)
    parts.push(`${minutes} ${formatMessage({ id: UNIT_IDS.minute })}`);
  parts.push(`${seconds.toFixed(1)} ${formatMessage({ id: UNIT_IDS.second })}`);
  return parts.join(" ");
}
