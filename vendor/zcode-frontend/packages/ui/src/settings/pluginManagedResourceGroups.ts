import type {
  PluginCommand,
  SkillSummary,
  UserCommand,
  ZCodeCommand,
  ZCodePluginInfo,
  ZCodePluginComponentKind,
  ZCodePluginsDescribeResult,
} from "@zcode/shared";
import { isPluginCommand, isUserCommand, ZCODE_COMMAND_AGENT_SOURCE } from "@zcode/shared";
interface PluginComponentDisplayGroup {
  kind: ZCodePluginComponentKind;
  count: number;
  items: Array<{ name: string; description?: string }>;
}

export interface ResourceGroups<TLocal, TPlugin> {
  local: TLocal[];
  plugin: TPlugin[];
}

/** 详情分组的展示顺序，与 describeResultToDisplayGroups / buildInstalledPluginDisplayGroups 一致。 */
const COMPONENT_KIND_ORDER: ZCodePluginComponentKind[] = [
  "agent",
  "command",
  "skill",
  "hook",
];

/**
 * 把 plugins/describe 的按需结果映射为共享展示分组（名称+描述），并按固定顺序排序、
 * 省略空分组。数量取 items.length（describe 已是权威枚举）。
 */
export function describeResultToDisplayGroups(
  result: ZCodePluginsDescribeResult,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  for (const group of result.components) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

/**
 * 把 plugins/list 下发的权威 components（名称+描述）映射为共享展示分组，逻辑与
 * describeResultToDisplayGroups 一致：按固定顺序排序、省略空分组、数量取 items.length。
 *
 * 已安装详情弹窗过去用 buildPluginComponentGroups —— 数量取协议 skillCount、名称靠
 * UI 侧 join（skillsService 结果按 pluginName 过滤）。两数据源分离导致停用插件整组消失、
 * 启用插件只有数量没有名称。现在 CLI 已对插件根目录做权威枚举并随 list 下发 components，
 * 这里直接用它，彻底去掉脆弱的 join。
 */
export function buildInstalledPluginDisplayGroups(
  plugin: ZCodePluginInfo,
): PluginComponentDisplayGroup[] {
  const byKind = new Map<ZCodePluginComponentKind, PluginComponentDisplayGroup>();
  for (const group of plugin.components ?? []) {
    if (group.items.length === 0) continue;
    byKind.set(group.kind, {
      kind: group.kind,
      count: group.items.length,
      items: group.items.map((item) => ({
        name: item.name,
        ...(item.description ? { description: item.description } : {}),
      })),
    });
  }
  return COMPONENT_KIND_ORDER.map((kind) => byKind.get(kind)).filter(
    (group): group is PluginComponentDisplayGroup => group !== undefined,
  );
}

function normalizedQueryMatches(query: string, values: readonly (string | undefined)[]): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) {
    return true;
  }
  return values.some((value) => value?.toLowerCase().includes(keyword));
}

export function groupSkillsByPlugin(
  skills: SkillSummary[],
  query: string,
): ResourceGroups<SkillSummary, SkillSummary> {
  const seenPaths = new Set<string>();
  const local: SkillSummary[] = [];
  const plugin: SkillSummary[] = [];
  for (const skill of skills) {
    const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
    if (seenPaths.has(normalizedPath)) {
      continue;
    }
    seenPaths.add(normalizedPath);
    if (!normalizedQueryMatches(query, [skill.name, skill.description, skill.pluginName])) {
      continue;
    }
    if (skill.scope === "plugin") {
      plugin.push(skill);
    } else {
      local.push(skill);
    }
  }
  return { local, plugin };
}

export function groupCommandsByPlugin(
  commands: ZCodeCommand[],
  query: string,
): ResourceGroups<UserCommand, PluginCommand> {
  const local: UserCommand[] = [];
  const plugin: PluginCommand[] = [];
  for (const command of commands) {
    if (
      isUserCommand(command) &&
      command.agentSource === ZCODE_COMMAND_AGENT_SOURCE &&
      normalizedQueryMatches(query, [command.name, command.description, command.prompt])
    ) {
      local.push(command);
      continue;
    }
    if (
      isPluginCommand(command) &&
      normalizedQueryMatches(query, [
        command.name,
        command.description,
        command.prompt,
        command.pluginName,
      ])
    ) {
      plugin.push(command);
    }
  }
  return { local, plugin };
}

