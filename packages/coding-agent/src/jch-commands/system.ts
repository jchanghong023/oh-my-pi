import type { SlashCommandSpec } from "../slash-commands/types";
import { defineJchPromptCommand } from "./define";

const SYSTEM_TOOL_GUIDANCE = `先识别当前实际操作系统、shell/命令环境以及 OMP 可用的内置工具，再选择正确做法；不要默认用户一定在 bash/Linux。优先直接完成任务，而不是只给用户一串需要记忆的命令。`;

export const JCH_SYSTEM_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	defineJchPromptCommand({
		name: "jchsyswhich",
		description: "JCH System：定位命令/可执行文件及实际解析路径",
		inlineHint: "<command> [更多命令]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n定位参数指定的命令或可执行文件，说明当前 shell 实际会解析到哪个路径、是否存在 alias/function/builtin 等覆盖，以及可获得的版本信息。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchsysport",
		description: "JCH System：查看端口占用和监听进程",
		inlineHint: "<port 或 process> [tcp/udp]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n根据参数检查端口占用。找出监听/连接的协议、本地地址、PID 和进程名称；如果参数给的是进程，则反查它使用的端口。只读，不结束进程。`,
	}),
	defineJchPromptCommand({
		name: "jchsysprocess",
		description: "JCH System：查找进程并查看资源/启动信息",
		inlineHint: "<进程名/PID> [关注点]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n检查参数指定的进程。展示 PID、父进程、命令行、CPU/内存等当前可获得信息；需要时说明进程树和监听端口。只读，不 kill/restart。`,
	}),
	defineJchPromptCommand({
		name: "jchsysdisk",
		description: "JCH System：查看磁盘/文件系统空间",
		inlineHint: "[路径或盘符]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n查看磁盘或文件系统空间，报告总量、已用、可用和占用比例；参数指定路径/盘符时聚焦对应文件系统。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchsysdu",
		description: "JCH System：统计目录/文件空间占用",
		inlineHint: "[路径、深度或 top N]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n统计参数指定路径的空间占用；没有参数时使用当前目录。优先给出顶层汇总和最大的若干子项，避免输出海量逐文件列表。只读，并明确单位。`,
	}),
	defineJchPromptCommand({
		name: "jchsystree",
		description: "JCH System：显示目录树",
		inlineHint: "[路径、深度、过滤条件]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n以紧凑目录树展示目标路径。没有参数时使用当前目录；自动忽略明显噪声目录，除非用户明确要求。参数可指定深度、文件类型或是否只看目录。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchsysenv",
		description: "JCH System：查看环境变量和有效值",
		inlineHint: "[变量名/关键词]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n检查环境变量。参数给出变量名/关键词时只查看相关项；没有参数时不要无脑输出整个环境，先展示常用且与当前上下文相关的变量。默认隐藏或脱敏 token、password、secret、key、credential 等敏感值。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchsysproxy",
		description: "JCH System：检查当前代理配置和生效来源",
		inlineHint: "[URL、应用或代理变量]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n检查当前有效代理配置，包括与环境匹配的 HTTP/HTTPS/ALL_PROXY/NO_PROXY、系统或工具级配置，并区分“已配置”和“实际对当前命令生效”。参数可指定应用、URL 或变量。不要泄露代理认证凭据。只读。`,
	}),
	defineJchPromptCommand({
		name: "jchsysjson",
		description: "JCH System：格式化/查询 JSON",
		inlineHint: "<文件或 JSON> [查询要求]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n处理参数指定的 JSON 文件或 JSON 文本。根据要求完成格式化、校验、字段查询、筛选或结构摘要；如果需要修改文件，只在参数明确要求写回时修改，并保持最小必要差异。`,
	}),
	defineJchPromptCommand({
		name: "jchsyshash",
		description: "JCH System：计算/校验文件哈希",
		inlineHint: "<文件> [sha256/sha1/md5 或 expected hash]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n对参数指定的文件计算哈希。未指定算法时优先 SHA-256；如果参数同时给出 expected hash，则比较并明确报告是否一致。只读文件内容，不修改目标。`,
	}),
	defineJchPromptCommand({
		name: "jchsysarchive",
		description: "JCH System：创建/查看/解压压缩包",
		inlineHint: "<archive/path> [create/list/extract 及要求]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n根据参数创建、查看或解压常见压缩包。执行解压前检查目标目录并避免路径穿越或意外覆盖；创建压缩包时只包含用户指定范围。完成后验证输出路径和主要内容。`,
	}),
	defineJchPromptCommand({
		name: "jchsyshttp",
		description: "JCH System：发送/诊断 HTTP 请求",
		inlineHint: "<URL> [method/header/body/关注点]",
		prompt: `${SYSTEM_TOOL_GUIDANCE}\n根据参数向目标 URL 发送或诊断 HTTP 请求。自动选择合适的当前环境工具，支持 method、headers、body 和状态/响应检查；默认展示状态码、关键响应头和必要的响应内容。不要在输出中泄露 Authorization、Cookie、token 等敏感信息，也不要对未授权目标做破坏性请求。`,
	}),
];
