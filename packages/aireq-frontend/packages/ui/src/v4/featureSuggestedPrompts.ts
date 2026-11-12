import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

export const featureSuggestedPrompts: DraftSuggestedPromptItem[] = [
  {
    id: "feature-coding-repo-start",
    iconName: "terminal",
    label: {
      cn: "帮我看懂并运行当前仓库",
      en: "Help me understand and run this repository",
    },
    prompt: {
      cn: "帮我快速了解当前打开的仓库是做什么的、主要功能在哪里，以及在这台电脑上怎样启动它。请实际尝试运行一个最核心的流程，最后给我一份简明上手说明，标出关键文件、运行结果和遇到的阻碍；如果当前没有打开仓库，先让我选择一个。",
      en: "Help me understand what the open repository does, where its main features live, and how to run it on this computer. Try one core workflow, then give me a concise guide with key files, what ran successfully, and any blockers. If no repository is open, ask me to select one.",
    },
  },
  {
    id: "feature-coding-branch-review",
    iconName: "git-branch",
    label: {
      cn: "帮我检查当前分支提交前的问题",
      en: "Check this branch before I submit it",
    },
    prompt: {
      cn: "请检查当前打开的仓库里这个分支准备提交的改动。先确认它相对哪个目标分支，再结合改动涉及的功能找出明确的错误、兼容性风险和遗漏的边界；按严重程度告诉我问题、代码位置、触发方式和建议。如果没有发现可确认的问题，也说明检查了什么和仍需验证什么。",
      en: "Review the changes on the current branch of the open repository before I submit them. Identify the target branch, then look for concrete bugs, compatibility risks, and missed edge cases in the affected features. Rank findings by severity with code locations, triggers, and suggestions. If nothing is confirmed, tell me what was checked and what still needs verification.",
    },
  },
  {
    id: "feature-coding-check-failures",
    iconName: "terminal",
    label: {
      cn: "帮我运行项目现有检查并定位失败",
      en: "Run the existing checks and diagnose failures",
    },
    prompt: {
      cn: "帮我检查当前仓库现有的代码检查和测试能否通过。请优先运行项目已经配置、在当前环境可执行的检查；如果失败，定位最可能的原因，区分本分支引入的问题和原有问题，并给我可执行的修复建议。不要把没运行的检查写成通过，也先不要大范围改代码。",
      en: "Check whether the open repository’s existing code checks and tests pass. Run the checks already configured and feasible in this environment. For failures, identify likely causes, separate issues introduced by this branch from existing ones, and suggest actionable fixes. Do not call unrun checks passes or make broad code changes yet.",
    },
  },
  {
    id: "feature-coding-mr-summary",
    iconName: "git-pull-request",
    label: {
      cn: "帮我整理当前分支的 MR 描述",
      en: "Draft a merge request description for this branch",
    },
    prompt: {
      cn: "请根据当前仓库这个分支相对目标分支的实际改动，帮我写一份可以直接检查的 MR 描述：说明改动目的、用户可见的变化、主要实现、验证结果和已知风险。没有运行过的验证请明确标为未验证；如果目标分支不明确，先向我确认。先给我草稿，不要直接发布 MR。",
      en: "Draft a merge request description from this branch’s actual changes against its target branch. Cover the purpose, user-visible behavior, main implementation, verification results, and known risks. Mark checks that were not run as unverified. Ask me if the target branch is unclear. Show me the draft without publishing the MR.",
    },
  },
  {
    id: "feature-coding-dependencies",
    iconName: "terminal",
    label: {
      cn: "帮我检查仓库的依赖和升级风险",
      en: "Review this repository’s dependencies and upgrade risks",
    },
    prompt: {
      cn: "帮我检查当前仓库的主要依赖，找出已经过时、存在明确安全风险或阻碍后续升级的部分。结合项目实际使用情况，按优先级给我一份清单，说明影响、证据和建议的升级顺序；不要仅凭版本旧就判定有问题，也先不要批量升级。",
      en: "Review the open repository’s main dependencies for outdated packages, confirmed security risks, and likely upgrade blockers. Consider how this project actually uses them, then give me a prioritized list with impact, evidence, and a suggested upgrade order. Do not treat age alone as a defect or upgrade everything yet.",
    },
  },
  {
    id: "feature-coding-scheduled-ci",
    iconName: "calendar-clock",
    label: {
      cn: "每天检查当前仓库有没有新的 CI 失败",
      en: "Check this repository for new CI failures daily",
    },
    prompt: {
      cn: "帮我为当前打开的仓库设置一个每个工作日上午 9 点运行的定时任务，查看远端过去 24 小时新增的 CI 失败。只报告仍需处理的失败，列出失败的流水线或任务、对应分支与提交、错误证据和建议的下一步；没有新的失败就简短说明。若仓库没有远端 CI 或运行环境无权访问，创建前先告诉我。",
      en: "Set up a scheduled task for 9 a.m. every workday for the open repository. Check its remote CI for failures newly seen in the past 24 hours. Report only failures that still need attention, with the pipeline or job, branch and commit, error evidence, and a next step. Give a brief all-clear if there are none. Tell me before creating the task if the repository has no remote CI or the scheduled environment cannot access it.",
    },
  },
  {
    id: "feature-coding-scheduled-weekly-changes",
    iconName: "calendar-days",
    label: {
      cn: "每周汇总当前仓库的改动和待处理风险",
      en: "Summarize this repository’s changes and risks weekly",
    },
    prompt: {
      cn: "帮我为当前打开的仓库设置一个每周五下午 5 点运行的定时任务，回顾这一周合入的改动和仍未解决的失败或阻塞。给我一份简短周报，按功能变化、验证情况和下周需要关注的风险整理，并附对应提交、MR 或 CI 链接。不要把尚未合入的改动写成已完成；如果任务运行环境无法访问仓库或远端，创建前先说明。",
      en: "Set up a scheduled task for 5 p.m. every Friday for the open repository. Review changes merged this week and failures or blockers still open. Send me a short update grouped by feature changes, verification, and risks to watch next week, with commit, merge request, or CI links. Do not call unmerged work complete. Tell me before creating the task if its environment cannot access the repository or remote.",
    },
  },
];

