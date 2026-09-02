export type HelpTopicId =
  | "getting-started"
  | "delegation-protocol"
  | "task-orchestration"
  | "capability-profiles"
  | "provider-connections"
  | "cli-runtime"
  | "execution-permissions"
  | "mcp"
  | "workspace-scope"
  | "data-and-backups"
  | "updates";

export type HelpTopic = {
  id: HelpTopicId;
  title: string;
  summary: string;
  group: "入门" | "Agent" | "能力" | "数据与维护";
  sections: Array<{ title: string; body: string; steps?: string[] }>;
};

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "getting-started",
    title: "开始使用 Meta Code",
    summary: "从检测 Agent、选择任务位置到完成第一次任务。",
    group: "入门",
    sections: [
      { title: "准备 Agent", body: "先在 Agent 设置中检测系统 CLI，或安装工作台托管版本。连接状态正常后，再测试账号或 API。" },
      { title: "创建任务", body: "需要读写项目时添加工作区；不依赖项目目录的临时问题可以直接创建临时任务。", steps: ["选择主脑 Agent", "确认原生或协作模式", "发送任务并检查日志与文件 Diff"] },
      { title: "数据边界", body: "个人配置、会话、Skill、MCP 和托管 CLI 保存在用户目录下的 .metacode，不随源码目录删除。" }
    ]
  },
  {
    id: "delegation-protocol",
    title: "协作模式与委派协议",
    summary: "主脑把边界清晰的子任务交给其他 Agent，并统一收集结果。",
    group: "Agent",
    sections: [
      { title: "原生模式", body: "任务直接由当前 CLI 处理，并保留该 CLI 自身的子 Agent、权限和会话能力。" },
      { title: "协作模式", body: "当前 Agent 仍是主脑，但可以通过工作台委派协议调用任意已连接且支持执行的 Agent。协议统一传递工作区、任务边界、权限和验收条件，再把结构化结果与日志归还主脑。" },
      { title: "协作闭环", body: "子 Agent 不直接替代主脑回答。主脑负责选择执行者、控制并发、处理失败和取消、复核文件 Diff 与测试结果，最后统一交付。", steps: ["确认子 Agent 已连接", "给出明确范围和验收条件", "查看子 Agent 实时日志", "由主脑检查产物并整合回复"] },
      { title: "适用场景", body: "适合可独立验证的调研、编码、测试和审查任务。多个 Agent 不应并发修改同一批文件；强依赖、多阶段的大任务更适合使用任务编排。" }
    ]
  },
  {
    id: "task-orchestration",
    title: "Meta 任务编排",
    summary: "先审查计划，再按依赖并行执行，并统一验收交付物。",
    group: "Agent",
    sections: [
      { title: "与委派协议的区别", body: "委派协议服务于一次对话中的主脑协作；任务编排是独立的长流程任务系统，显式保存计划、节点依赖、执行状态、机器检查和最终交付。编排节点仍可复用统一的 Agent 适配与委派能力。" },
      { title: "执行阶段", body: "规划 Agent 先把目标拆成有依赖关系的节点，并声明每个节点的 Provider、读写权限、Skill、MCP、验收条件和交付物。用户批准计划后，调度器才会按依赖和并发上限执行。", steps: ["创建完整任务", "审查假设、风险和节点", "批准或要求重新规划", "跟踪节点日志与产物", "由集成阶段完成最终验收"] },
      { title: "可恢复与可审计", body: "计划版本、节点尝试、日志、结果文件和最终交付都保存在任务目录中。节点失败可以定点重试，暂停后可以继续，不需要重跑已经通过验收的节点。" },
      { title: "适用场景", body: "适合需要多个角色、存在前后依赖、运行时间较长或必须产出明确文件的工作，例如大型重构、发布检查、研究和完整内容生产。简单问答或单点修改优先使用普通任务。" }
    ]
  },
  {
    id: "capability-profiles",
    title: "能力方案与 Skill 策略",
    summary: "保存一组 Skill 调用策略，并在不同工作任务间快速切换。",
    group: "能力",
    sections: [
      { title: "能力方案", body: "能力方案保存当前 Skill 策略。再次保存已选方案会覆盖更新，不会重复创建。" },
      { title: "调用策略", body: "始终表示每轮都注入，自动表示按任务判断，手动表示仅显式调用，关闭表示不提供给 Agent。" },
      { title: "临时调用", body: "只影响当前一轮，不会修改工作区或已保存方案。" }
    ]
  },
  {
    id: "provider-connections",
    title: "Provider、模型与连接",
    summary: "统一配置官方账号、兼容 API、模型发现和连接测试。",
    group: "Agent",
    sections: [
      { title: "连接方案", body: "每个 Provider 可以保存独立连接。API Key 会进入本机加密凭据库，不写入普通状态数据库。" },
      { title: "探测模型", body: "连接信息保存后，探测模型会读取服务端或 Agent 暴露的模型列表。服务不提供列表时仍可手动填写。" },
      { title: "ACP 配置", body: "ACP Agent 的模型、模式和思考强度由会话能力协商动态提供，工作台不会硬编码不存在的选项。" }
    ]
  },
  {
    id: "cli-runtime",
    title: "CLI 来源与运行环境",
    summary: "区分系统 CLI、指定路径和工作台托管版本。",
    group: "Agent",
    sections: [
      { title: "来源优先级", body: "指定路径优先，其次是工作台托管版本、产品内置版本，最后是系统 PATH。" },
      { title: "工作台托管", body: "托管版本安装在 .metacode/runtimes 中，按版本隔离并支持原子切换和回退，不覆盖系统 CLI。" },
      { title: "安装与更新", body: "安装过程展示真实下载和校验阶段。只有探测到可用新版本时才执行更新。" }
    ]
  },
  {
    id: "execution-permissions",
    title: "执行、权限与联网",
    summary: "决定 Agent 能读取、修改和执行哪些内容。",
    group: "Agent",
    sections: [
      { title: "项目权限", body: "完全访问权限最高；仅工作区写入会限制工作区外修改；只读适合分析和审查。" },
      { title: "审批", body: "自动执行适合可信工作区，按需询问适合可能包含危险命令或敏感文件的任务。" },
      { title: "联网", body: "实时联网允许即时请求；缓存搜索只使用可用缓存；关闭联网会阻止声明该能力的 Agent 访问网络。" }
    ]
  },
  {
    id: "mcp",
    title: "MCP 工具连接",
    summary: "把外部工具和数据源按工作区注入支持 MCP 的 Agent。",
    group: "能力",
    sections: [
      { title: "作用范围", body: "MCP 配置由工作台统一保存，每个工作区可以独立启用。只有声明 MCP 能力的 Agent 会收到配置。" },
      { title: "连接测试", body: "启用前先运行测试。STDIO 需要有效命令和环境变量，HTTP/SSE 需要可访问地址和认证信息。" },
      { title: "凭据", body: "环境变量和请求头中的秘密值进入加密凭据库，普通界面和日志只显示脱敏状态。" }
    ]
  },
  {
    id: "workspace-scope",
    title: "工作区任务与临时任务",
    summary: "任务可以绑定真实项目，也可以脱离工作区运行。",
    group: "入门",
    sections: [
      { title: "工作区任务", body: "绑定本地目录，可以浏览、预览和修改文件，也可以运行需要项目上下文的任务编排。" },
      { title: "临时任务", body: "不绑定项目目录，适合咨询、规划和无需文件写入的任务。之后可以另建工作区任务继续落地。" }
    ]
  },
  {
    id: "data-and-backups",
    title: "个人数据与备份",
    summary: "源码、个人状态、CLI 程序和项目文件彼此分离。",
    group: "数据与维护",
    sections: [
      { title: "个人数据", body: "会话、工作区索引、设置、Skill、MCP 和凭据默认位于 ~/.metacode。卸载程序不会自动删除它。" },
      { title: "项目文件", body: "工作区源码仍保存在用户选择的原目录，工作台只保存引用，不复制整个项目。" },
      { title: "恢复", body: "升级或重大配置变更前创建数据库备份。恢复操作必须在完全退出 Meta Code 后执行。" }
    ]
  },
  {
    id: "updates",
    title: "软件更新",
    summary: "检查版本、选择频道，并在兼容条件满足时更新。",
    group: "数据与维护",
    sections: [
      { title: "版本检查", body: "工作台只读取发布清单或 GitHub Release 公告，不会对正在运行的源码执行 git pull。" },
      { title: "安装边界", body: "未来 Launcher 负责下载、校验、切换和回滚；个人数据目录不会随程序版本替换。" }
    ]
  }
];

export const HELP_TOPIC_BY_ID = new Map(HELP_TOPICS.map((topic) => [topic.id, topic]));
