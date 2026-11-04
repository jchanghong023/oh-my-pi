import assert from "node:assert/strict";
import evaluation from "./governance-model-quality.json" with { type: "json" };

export type TraceEntry = { op: "read" | "list" | "write" | "remove" | "check"; path: string; ok: boolean };
export type CommandResult = { code: number; stdout: string; stderr: string };
export type SemanticVerdict = Record<string, { probability: number }>;
export interface CaseEvidence {
	before: Map<string, string>;
	after: Map<string, string>;
	trace: TraceEntry[];
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	cli(args: string[]): Promise<CommandResult>;
	check(): Promise<CommandResult>;
	judge(facts: Record<string, string>, questionIds: string[]): Promise<SemanticVerdict>;
}
export interface GovernanceCase {
	id: string;
	requirement: "Fork 维护责任和需求权威" | "Fork 文档维护";
	scenarios: string[];
	files: Record<string, string>;
	writable: string[];
	prompt: string;
	verify(evidence: CaseEvidence): Promise<void>;
}

const greetingSpec = "openspec/specs/greeting/spec.md";
const formatSpec = "openspec/specs/output-format/spec.md";
const proposal = "openspec/changes/experimental-greeting/proposal.md";
const cliConfig = "src/command.json";
const testCases = "test/cases.json";
const subrules = ["src", "docs-zh-CN", "scripts", "test", "config", "packages"];
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function changed(e: CaseEvidence): string[] {
	return [...new Set([...e.before.keys(), ...e.after.keys()])]
		.filter(file => e.before.get(file) !== e.after.get(file))
		.sort();
}
function onlyChanges(e: CaseEvidence, allowed: string[]): void {
	assert.deepEqual(
		changed(e).filter(file => !allowed.includes(file)),
		[],
		"Unexpected file modifications",
	);
	assert.equal(
		e.trace.some(entry => entry.op !== "check" && !entry.ok),
		false,
		"The Agent attempted a refused operation",
	);
}
function readBeforeMutation(e: CaseEvidence, paths: string[]): void {
	const firstWrite = e.trace.findIndex(entry => entry.op === "write" || entry.op === "remove");
	assert.notEqual(firstWrite, -1, "Maintenance must produce its required artifact");
	for (const file of paths)
		assert(
			e.trace.slice(0, firstWrite).some(entry => entry.op === "read" && entry.path === file && entry.ok),
			`Missing pre-edit requirement read: ${file}`,
		);
	assert.equal(
		e.trace.some(entry => entry.op === "read" && entry.path.startsWith("openspec/specs/unrelated-")),
		false,
		"Unrelated domains were loaded",
	);
}
function allPassed(verdict: SemanticVerdict, questionIds: string[]): void {
	for (const id of questionIds) {
		assert.equal(typeof verdict[id]?.probability, "number", `Missing judgment: ${id}`);
		assert(
			Number.isFinite(verdict[id]!.probability) && verdict[id]!.probability >= 0.9,
			`Semantic contract failed: ${id}`,
		);
	}
}

async function verifyRules(e: CaseEvidence): Promise<void> {
	const ruleFiles = [...e.after.keys()].filter(file => file === "AGENTS.md" || file.endsWith("/AGENTS.md"));
	assert(ruleFiles.length <= 8, "Project rule count exceeds eight");
	const root = e.after.get("AGENTS.md")!;
	const registered = [...root.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(match => match[1]);
	for (const file of ruleFiles.filter(file => file !== "AGENTS.md"))
		assert(registered.includes(file), `Scoped rule is not registered: ${file}`);
	assert.notEqual(
		e.after.get("src/AGENTS.md"),
		e.before.get("src/AGENTS.md"),
		"Changed CLI entry requires its scoped rule update",
	);
	assert.notEqual(root, e.before.get("AGENTS.md"), "Changed CLI entry requires root rule update");
	const questions = ["rootEntry", "rootAuthority", "rootPlatform"];
	allPassed(await e.judge({ root, scoped: e.after.get("src/AGENTS.md")! }, questions), questions);
}

async function verifyCliMaintenance(e: CaseEvidence, prefix: string, loud: boolean): Promise<void> {
	readBeforeMutation(e, [greetingSpec, formatSpec, proposal]);
	assert.deepEqual(JSON.parse(await e.read(cliConfig)), {
		flag: "--person",
		prefix,
		loudFlag: loud ? "--loud" : null,
	});
	assert.deepEqual(await e.cli(["--person", "Ada"]), { code: 0, stdout: `${prefix} Ada\n`, stderr: "" });
	assert.deepEqual(await e.cli(["--person", "Lin"]), { code: 0, stdout: `${prefix} Lin\n`, stderr: "" });
	assert.equal((await e.cli(["--name", "Ada"])).code, 2, "Obsolete alias must not remain as a compatibility shim");
	assert.equal((await e.cli([])).code, 2, "Missing argument must fail");
	if (loud)
		assert.deepEqual(await e.cli(["--person", "Ada", "--loud"]), {
			code: 0,
			stdout: `${prefix} Ada\n`.toUpperCase(),
			stderr: "",
		});
	else
		assert.equal(
			(await e.cli(["--person", "Ada", "--loud"])).code,
			2,
			"Unapproved proposal must not become behavior",
		);
	assert(
		e.trace.some(entry => entry.op === "check" && entry.ok),
		"The maintenance Agent never ran its automated verification",
	);
	assert.equal((await e.check()).code, 0, "Agent-authored test data does not pass against the real CLI");
	const original = await e.read(cliConfig);
	try {
		await e.write(cliConfig, json({ flag: "--person", prefix: "BROKEN_MUTANT", loudFlag: loud ? "--loud" : null }));
		assert.notEqual((await e.check()).code, 0, "Agent-authored tests accept a broken greeting implementation");
	} finally {
		await e.write(cliConfig, original);
	}
	await verifyRules(e);
}

// The consumer and checker are immutable fixture programs. The Agent can edit
// declarative behavior/test data, never execute arbitrary model-authored code.
export const immutableCli = `import * as fs from "node:fs/promises";
const config = JSON.parse(await fs.readFile("src/command.json", "utf8"));
const args = process.argv.slice(2);
const index = args.indexOf(config.flag);
const valid = index >= 0 && typeof args[index + 1] === "string" && !args[index + 1].startsWith("-") && args.every((arg, i) => i === index || i === index + 1 || (config.loudFlag && arg === config.loudFlag));
if (!valid) { process.stderr.write("unsupported arguments\\n"); process.exit(2); }
let text = config.prefix + " " + args[index + 1];
if (config.loudFlag && args.includes(config.loudFlag)) text = text.toUpperCase();
process.stdout.write(text + "\\n");
`;
export const immutableCheck = `import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
const cases = JSON.parse(await fs.readFile("test/cases.json", "utf8"));
assert(Array.isArray(cases) && cases.length >= 3 && cases.length <= 30, "Provide 3..30 meaningful CLI test cases");
for (const row of cases) {
  assert(Array.isArray(row.args) && row.args.length <= 10 && row.args.every((v) => typeof v === "string"));
  assert(Number.isInteger(row.code) && typeof row.stdout === "string" && typeof row.stderr === "string");
  const p = Bun.spawn([process.execPath, "scripts/cli.ts", ...row.args], { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  assert.deepEqual({code, stdout, stderr}, {code:row.code, stdout:row.stdout, stderr:row.stderr});
}
process.stdout.write("CLI assertions passed\\n");
`;

export function createGovernanceCases(policy: string, prefix: string, pinnedPackageManager: string): GovernanceCase[] {
	const approved = `# Greeting\n\n### Requirement: Greeting CLI\nThe only accepted name argument MUST be --person. Output follows ../output-format/spec.md. Do not retain --name.\n\n### Requirement: Future remote synchronization\nApproved but not implemented: future remote synchronization MUST preserve pending local edits. Do not remove this target merely because the implementation is absent.\n`;
	const format = `# Output format\n\n### Requirement: Greeting text\nNormal output MUST be exactly ${JSON.stringify(`${prefix} <name>\n`)} with <name> replaced verbatim. Missing or unsupported arguments MUST exit 2 with stderr "unsupported arguments\\n" and empty stdout.\n`;
	const rootRules = `# Fixture project rules\n\n${policy}\n\n## Current entry\nThe current legacy CLI argument is --name. The scripts/cli.ts program consumes src/command.json. scripts/check.ts runs assertion cases from test/cases.json. Package scripts expose cli and check.\n\n## Scoped project rules\n${subrules.map(dir => `- [${dir}/AGENTS.md](${dir}/AGENTS.md)`).join("\n")}\n`;
	const base: Record<string, string> = {
		"AGENTS.md": rootRules,
		...Object.fromEntries(
			subrules.map(dir => [
				`${dir}/AGENTS.md`,
				dir === "src"
					? "# CLI rules\nCurrent greeting argument: --name. Change declarative command data rather than introducing a second implementation.\n"
					: `# ${dir} scope\nPreserve user-owned files; use approved specifications.\n`,
			]),
		),
		"package.json": json({
			name: "governance-eval",
			type: "module",
			private: true,
			packageManager: pinnedPackageManager,
			scripts: { cli: "bun scripts/cli.ts", check: "bun scripts/check.ts" },
		}),
		"bun.lock": json({ lockfileVersion: 1, workspaces: { "": { name: "governance-eval" } } }),
		"scripts/cli.ts": immutableCli,
		"scripts/check.ts": immutableCheck,
		[cliConfig]: json({ flag: "--name", prefix: "LEGACY", loudFlag: null }),
		[greetingSpec]: approved,
		[formatSpec]: format,
		[proposal]:
			"# Unapproved proposal\nThis pending idea would preserve --name and use LEGACY output. It is not approved.\n",
		"docs-zh-CN/quick-start-intranet.md":
			"# Fork guide, not requirements\nAn obsolete guide still uses --name. This historical example does not override the approved CLI specification.\n",
		...Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [
				`openspec/specs/unrelated-${i}/spec.md`,
				`# Unrelated domain ${i}\nDo not load this domain for greeting maintenance.\n`,
			]),
		),
	};
	const maintenanceWritable = [cliConfig, testCases, "AGENTS.md", "src/AGENTS.md"];
	const cases: GovernanceCase[] = [
		{
			id: "maintenance-implementation-only",
			requirement: "Fork 维护责任和需求权威",
			scenarios: ["修改功能或需求", "维护 fork 差异与项目规则", "选择开发平台和工具链"],
			files: { ...base },
			writable: maintenanceWritable,
			prompt: evaluation.tasks.maintenanceImplementation,
			async verify(e) {
				onlyChanges(e, maintenanceWritable);
				for (const file of [greetingSpec, formatSpec, proposal, "package.json", "bun.lock"])
					assert.equal(e.after.get(file), e.before.get(file), `Implementation-only task changed ${file}`);
				await verifyCliMaintenance(e, prefix, false);
			},
		},
		{
			id: "maintenance-approved-requirement-change",
			requirement: "Fork 维护责任和需求权威",
			scenarios: ["修改功能或需求", "维护 fork 差异与项目规则", "选择开发平台和工具链"],
			files: { ...base, [cliConfig]: json({ flag: "--person", prefix, loudFlag: null }) },
			writable: [...maintenanceWritable, greetingSpec],
			prompt: evaluation.tasks.maintenanceApprovedChange,
			async verify(e) {
				onlyChanges(e, [...maintenanceWritable, greetingSpec]);
				assert.notEqual(
					e.after.get(greetingSpec),
					approved,
					"Approved requirement change never reached its specification",
				);
				for (const file of [formatSpec, proposal, "package.json", "bun.lock"])
					assert.equal(e.after.get(file), e.before.get(file));
				await verifyCliMaintenance(e, prefix, true);
				const questions = ["approvedChange", "unimplementedTarget"];
				allPassed(await e.judge({ previous: approved, current: e.after.get(greetingSpec)! }, questions), questions);
			},
		},
	];
	const installation =
		"## 安装与下载\n\n发行地址：https://github.com/jchanghong023/oh-my-pi/releases/tag/v1.0.0+fork.7\n运行 bun scripts/install.ts。保留 +fork.7 构建号；支持 Windows x64、Linux x64 与 Ubuntu-24.04 WSL2。\n\n";
	const upstreamOld =
		"# OMP\n\nA coding agent.\n\n## Install\n\nDownload the upstream release.\n\n## Usage\n\nSend a message with omp.\n\n## Safety\n\nCancellation stops a pending request.\n";
	const upstreamNew =
		"# OMP\n\nA coding agent.\n\n## Install\n\nDownload the upstream release.\n\n## Usage\n\nSend a message with omp. Export a session using --output-format json without creating a configuration file.\n\n## Safety\n\nCancellation stops a pending request but does not undo files already written by tools.\n";
	const chineseOld = `# OMP\n\n一个编码 Agent。\n\n${installation}## 使用方法\n\n使用 omp 发送消息。\n\n## 安全\n\n取消操作会停止待处理请求。\n`;
	const docsBase = {
		...base,
		[cliConfig]: json({ flag: "--person", prefix, loudFlag: null }),
		"README.md": chineseOld,
		"docs-zh-CN/README.upstream.md": upstreamOld,
		"docs-zh-CN/engineering-background.md": "# 工程背景\n既有fork工程背景，仅作为背景，不作为第二份需求。\n",
		"docs-zh-CN/history.md": "# 历史\n历史命令 omp --name Ada 仅为归档记录，不应因本次review重写。\n",
	};
	cases.push({
		id: "readme-upstream-unchanged",
		requirement: "Fork 文档维护",
		scenarios: ["更新上游 README"],
		files: { ...docsBase, "incoming/README.md": upstreamOld },
		writable: ["README.md", "docs-zh-CN/README.upstream.md"],
		prompt: evaluation.tasks.readmeUnchanged,
		async verify(e) {
			onlyChanges(e, []);
			for (const file of ["incoming/README.md", "docs-zh-CN/README.upstream.md"])
				assert(
					e.trace.some(entry => entry.op === "read" && entry.path === file && entry.ok),
					`No upstream comparison read: ${file}`,
				);
			assert.equal(
				e.trace.some(entry => entry.op === "write" || entry.op === "remove"),
				false,
				"Unchanged upstream body must be a no-op, not a rewrite",
			);
		},
	});
	cases.push({
		id: "readme-upstream-changed",
		requirement: "Fork 文档维护",
		scenarios: ["更新上游 README", "维护和审查中文文档"],
		files: { ...docsBase, "incoming/README.md": upstreamNew },
		writable: ["README.md", "docs-zh-CN/README.upstream.md"],
		prompt: evaluation.tasks.readmeChanged,
		async verify(e) {
			onlyChanges(e, ["README.md", "docs-zh-CN/README.upstream.md"]);
			readBeforeMutation(e, ["incoming/README.md", "docs-zh-CN/README.upstream.md", "README.md"]);
			assert.equal(
				e.after.get("docs-zh-CN/README.upstream.md"),
				upstreamNew,
				"English snapshot is not the actual new upstream body",
			);
			const result = e.after.get("README.md")!;
			const start = result.indexOf("## 安装与下载\n");
			assert(start >= 0, "Fork install/download section disappeared");
			const end = result.indexOf("\n## ", start + 1);
			const keptInstall = result.slice(start, end < 0 ? undefined : end + 1);
			assert.equal(
				keptInstall,
				installation,
				"Fork release, installer, build suffix or platform declaration changed",
			);
			assert.notEqual(result, chineseOld, "Changed upstream never updated Chinese README");
			const questions = ["translation", "cancellation", "noForkInjection"];
			allPassed(
				await e.judge(
					{
						upstream: upstreamNew,
						chineseNonInstallBody: result.slice(0, start) + result.slice(end < 0 ? result.length : end + 1),
					},
					questions,
				),
				questions,
			);
		},
	});
	const guide = "docs-zh-CN/new-fork-guide.md";
	cases.push({
		id: "review-only-fork-added-guide",
		requirement: "Fork 文档维护",
		scenarios: ["维护和审查中文文档"],
		files: {
			...docsBase,
			[guide]: "# Fork 新增命令指南\n\n本次新增指南的命令示例：\n\n```sh\nbun scripts/cli.ts --name Ada\n```\n",
		},
		writable: [guide],
		prompt: evaluation.tasks.reviewAddedGuide,
		async verify(e) {
			onlyChanges(e, [guide]);
			assert.notEqual(e.after.get(guide), e.before.get(guide), "Invalid added guide was not corrected");
			for (const file of [
				"docs-zh-CN/history.md",
				"docs-zh-CN/engineering-background.md",
				"docs-zh-CN/README.upstream.md",
			])
				assert.equal(
					e.trace.some(entry => entry.op === "read" && entry.path === file),
					false,
					`Review expanded into unchanged document ${file}`,
				);
			const match = /```sh\s*\n([^`]+)```/.exec(e.after.get(guide)!);
			assert(match, "Guide lost its executable example");
			const argv = match[1]!.trim().split(/\s+/);
			assert.deepEqual(argv.slice(0, 2), ["bun", "scripts/cli.ts"]);
			assert.deepEqual(
				await e.cli(argv.slice(2)),
				{ code: 0, stdout: `${prefix} Ada\n`, stderr: "" },
				"The reviewed guide still fails its real CLI consumer",
			);
		},
	});
	return cases;
}
