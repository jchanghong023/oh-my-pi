import { CRON_DEFAULT_GROUP_ID } from "@zcode/shared";

/** 定时任务系统分组标题按语言环境本地化展示。 */
function getTaskGroupDisplayTitle(
  group: { id: string; title: string },
  localizedSystemTitles: { cron: string },
): string {
  if (group.id === CRON_DEFAULT_GROUP_ID) return localizedSystemTitles.cron;
  return group.title;
}

export { getTaskGroupDisplayTitle };
