import type { ExtensionAPI } from "../../../../extensions/types";
import hint from "../prompts/user-prompt-hint.md" with { type: "text" };

const VERB = "(生成|创建|写|编写|补充|新增|添加|做|完成|补齐|增加|提高)";
const QUANTIFIER = "(一个|一下|对应的|相应的|符合规范的|[^\\n]{0,8}的)?";
const NOUN = "(单元测试|UT用例|UT测试|DT用例|DT测试|UT\\b|ut\\b|DT|LLT|llt|测试代码|测试类|测试用例|用例)";
const TARGET = "(方法|函数|类|文件|接口|这个类|该方法|该方法|这个接口|该接口)";
const PREP = "(为|给)";

const UNIT_TEST_PATTERN = new RegExp(
	"(" +
		"(" +
		PREP +
		".*" +
		TARGET +
		")?" +
		VERB +
		QUANTIFIER +
		NOUN +
		"|(行覆盖|分支覆盖).*\\d+%|\\d+%.*(行覆盖|分支覆盖)|覆盖率[^\\n]{0,10}(补充|新增|提升|达到|增加)[^\\n]*\\d+|(补充|新增|提升|达到|增加)[^\\n]{0,10}覆盖率[^\\n]*\\d+" +
		"|DT用例(.*\\d+%|.*覆盖)" +
		")",
	"i",
);

const HARD_EXCLUDE_PATTERN = new RegExp(
	"(" +
		"创建[^\\n]*skill" +
		"|skill[^\\n]*创建" +
		"|kvm-test-case" +
		"|test-case-generator" +
		"|api-abnormal-test" +
		"|c-cpp-dt" +
		"|韧性测试" +
		"|自动化率" +
		"|测试KPI" +
		"|分析[^\\n]{0,10}(指出|找出|需要)[^\\n]{0,10}补充(UT|单元测试)" +
		"|指出[^\\n]{0,10}需要补充(UT|单元测试)" +
		"|检查[^\\n]*覆盖" +
		"|检查[^\\n]*单元测试" +
		"|基于[^\\n]*commit" +
		"|最后一次commit" +
		"|testcase-generator" +
		"|software-test-design" +
		"|developer-test-agent" +
		"|DeveloperTestAgent" +
		"|xlink-testcase" +
		"|xlink[^\\n]*测试用例" +
		"|功能测试" +
		"|集成测试" +
		"|请原样输出以下内容" +
		")",
	"i",
);

function smartExclude(query: string): boolean {
	if (!query) return false;

	const hasExplicitGenerateRequest =
		/(帮我|请帮我|请给我|麻烦帮我)[^\n]{0,10}(生成|写|创建|编写|补充)[^\n]{0,10}(UT|单元测试|测试用例|unittest)/i;
	if (hasExplicitGenerateRequest.test(query)) return false;

	const nonTestGeneration =
		/生成[^\n]{0,5}(DTO|Dto|数据|配置|文档)(?![^\n]{0,15}(单元测试|unittest|UT\b|ut\b|测试用例|测试类|测试))/i;
	if (nonTestGeneration.test(query)) return true;

	const isTestCodeGeneration = /生成[^\n]{0,10}(测试代码|测试用例代码|UT代码|unittest代码)/i;
	if (isTestCodeGeneration.test(query)) return false;

	const pureCodeGeneration = /生成[^\n]{0,5}代码(?![^\n]{0,15}(单元测试|unittest|UT\b|ut\b|测试用例|测试类|测试))/i;
	if (pureCodeGeneration.test(query)) return true;

	const directNegation =
		/(不|不要|不需要|别|禁止)(生成|写|创建|编写|补充)[^\n]{0,5}(单元测试|UT用例|测试用例|测试类|UT\b|DT\b)/;
	if (directNegation.test(query)) {
		const hasTransition =
			/(不|不要|不需要)[^\n]{0,10}(，|；|,)[^\n]{0,10}(生成|写|创建|补充)[^\n]{0,5}(单元测试|测试用例|UT|DT|测试类)/;
		if (!hasTransition.test(query)) return true;
	}

	const questionPattern = /(吗|？|\?)[^\n]{0,3}$/;
	if (questionPattern.test(query)) {
		const inquiryQuestionPattern =
			/(你有没有|你有哪些|你有那些|有哪些|有那些|有没有[^\n]{0,10}(工具|Agent|方法|技能))/i;
		if (inquiryQuestionPattern.test(query)) return true;

		const hasGenerateAction = /(生成|写|创建|补充)[^\n]{0,5}(单元测试|UT|测试用例)/;
		if (!hasGenerateAction.test(query)) return true;
	}

	const discussionPattern = /(哪些|什么|怎么|如何|有没有)[^\n]{0,10}(工具|方法|技能|skill)/;
	if (discussionPattern.test(query)) return true;

	const analysisPattern =
		/(分析|指出|找出|检查|查看|确认|验证)[^\n]{0,10}(需要|是否|有没有)[^\n]{0,10}(补充|生成|写)[^\n]{0,5}(单元测试|UT|测试用例)/;
	if (analysisPattern.test(query)) return true;

	const inquiryPattern = /(讨论|询问|咨询|了解|知道)[^\n]{0,10}(生成|UT|单元测试)/;
	if (inquiryPattern.test(query)) return true;

	return false;
}

export function isUnitTestIntent(text: string): boolean {
	if (!text || text.trim().length === 0) return false;
	if (HARD_EXCLUDE_PATTERN.test(text)) return false;
	if (smartExclude(text)) return false;
	return UNIT_TEST_PATTERN.test(text);
}

export default function developerTestAgentHint(api: ExtensionAPI): void {
	api.on("before_agent_start", event => {
		if (!isUnitTestIntent(event.prompt)) return;
		return {
			message: {
				customType: "developer-test-agent-hint",
				content: hint,
				display: false,
			},
		};
	});
}
