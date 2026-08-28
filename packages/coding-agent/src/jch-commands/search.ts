import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

const SEARCH_TOOL_GUIDANCE = `优先使用 OMP 内置的 find、grep、glob/read 等搜索能力，而不是要求用户自己记忆复杂命令行参数。搜索任务默认只读，并明确搜索根目录、过滤条件和匹配数量。`;

export const JCH_SEARCH_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchfind",
		description: "JCH Find：按名称/路径模式查找文件和目录",
		inlineHint: "<名称或 glob> [根目录/过滤条件]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n根据参数查找匹配的文件和目录。参数可以是文件名片段、glob、扩展名或自然语言条件；没有给根目录时从当前工作目录开始。结果按相关性整理，避免无意义地遍历或输出巨大列表。`,
	}),
	defineJchPromptCommand({
		name: "jchfindfile",
		description: "JCH Find：只查找文件",
		inlineHint: "<名称或 glob> [根目录]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n只查找普通文件，不返回目录。按参数的名称、glob、扩展名、路径范围或其他条件过滤；结果多时给出匹配总数和最相关路径。`,
	}),
	defineJchPromptCommand({
		name: "jchfinddir",
		description: "JCH Find：只查找目录",
		inlineHint: "<目录名或模式> [根目录]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n只查找目录。按参数中的目录名、路径模式和根目录过滤；结果多时优先展示较浅且最相关的目录，并报告匹配数量。`,
	}),
	defineJchPromptCommand({
		name: "jchfindlarge",
		description: "JCH Find：查找大文件/大目录",
		inlineHint: "[路径、阈值或 top N]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n查找占用空间最大的文件或目录。没有参数时从当前目录出发，给出约 top 20，并避免把 .git 等明显内部数据淹没结果；参数可指定阈值、top N、路径和是否包含隐藏内容。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchfindrecent",
		description: "JCH Find：查找最近修改的文件",
		inlineHint: "[路径、时间范围或 top N]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n查找最近修改的文件。没有参数时从当前目录开始，按修改时间倒序给出一组最相关结果；参数可指定例如今天、24h、7d、top N、扩展名或目录。只读，并明确使用的时间范围。`,
	}),
	defineJchPromptCommand({
		name: "jchgrep",
		description: "JCH Grep：搜索文本/正则并定位匹配",
		inlineHint: "<文本或 regex> [路径/文件过滤]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n搜索参数指定的文本或正则表达式。自动选择合适的 literal/regex、大小写和文件过滤方式；默认返回文件、行号和匹配片段，并排除明显无关的生成物/二进制内容。不要修改文件。`,
	}),
	defineJchPromptCommand({
		name: "jchgrepcontext",
		description: "JCH Grep：搜索并显示上下文",
		inlineHint: "<文本或 regex> [上下文行数/路径]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n搜索目标文本/正则并显示命中前后的上下文。参数未指定上下文大小时选择足够理解代码/文本的少量行；合并相邻命中，避免重复输出。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchgrepfiles",
		description: "JCH Grep：只列出包含匹配的文件",
		inlineHint: "<文本或 regex> [路径/过滤]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n搜索目标内容，但只输出包含至少一个匹配的文件路径；同时报告文件数。参数可指定根目录、扩展名、include/exclude 或大小写要求。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchgrepcount",
		description: "JCH Grep：统计匹配次数/文件数",
		inlineHint: "<文本或 regex> [路径/过滤]",
		prompt: `${SEARCH_TOOL_GUIDANCE}\n统计目标文本/正则的匹配次数，并按文件汇总；同时给出总匹配数和包含匹配的文件数。参数可指定路径、文件类型、大小写和其他过滤条件。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchgrepreplace",
		description: "JCH Grep：查找并按范围替换匹配内容",
		inlineHint: "<查找内容> <替换要求> [范围]",
		prompt: `先使用 OMP 的搜索能力精确找出参数指定的匹配，再按用户给出的替换规则修改对应文件。修改前确认匹配范围不会误伤无关内容；优先最小必要编辑，不做无关格式化。修改后重新搜索验证旧匹配是否按预期消失、新内容是否正确，并总结改动文件。`,
	}),
];
