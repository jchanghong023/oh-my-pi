export const SKILL_DESIGN_FIELDS = [
	{ id: "goal", label: "要解决什么任务", hint: "用一句话描述核心目标。", placeholder: "例如：评审接口变更，找出兼容性问题", required: true },
	{ id: "when", label: "什么时候使用", hint: "说明适用场景，或给一句用户可能说的话。", placeholder: "例如：用户请求评审 API 变更或检查向后兼容性时", required: true },
	{ id: "inputs", label: "需要哪些输入", hint: "代码、文档、日志等；也可明确无需额外输入。", placeholder: "例如：当前 Git diff、接口定义和相关测试", required: true },
	{ id: "outputs", label: "期望结果与成功标准", hint: "需要什么产物，怎样判断它可用？", placeholder: "例如：按严重程度列出问题，附文件位置、影响和修改建议", required: true },
	{ id: "boundaries", label: "边界与不适用场景", hint: "说明不该做什么、哪些情况不适用。", placeholder: "例如：只分析，不修改代码；纯文档排版不触发", required: false },
	{ id: "references", label: "流程、规则或参考资料", hint: "已有模板、规范、工具或依赖。", placeholder: "例如：先阅读项目接口规范，再检查变更和测试", required: false },
	{ id: "example", label: "真实例子或失败情况", hint: "强烈建议给一个具体的输入和期望结果。", placeholder: "例如：删除必填响应字段时，指出受影响客户端及兼容方案", required: false },
] as const;
