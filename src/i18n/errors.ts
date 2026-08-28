/**
 * IPC 错误 → 中文文案。
 *
 * 背景：后端和 electron/ipc 层抛出的全部是英文 message，中间没有任何翻译层，
 * 于是「Run a connection test for this exact Provider configuration before translation」
 * 这种句子会原样出现在中文界面的红色横幅里。这个模块就是补上的那一层。
 *
 * 两级匹配：
 *   1. 先按 error.code 查表（稳定，优先）
 *   2. code 查不到时按 message 的特征串兜底（后端英文文案是稳定字符串常量）
 * 都没命中时给一句通用中文，并把英文原文保留在 debug 字段里供排查。
 */

export interface LocalizedError {
  /** 一句话说明发生了什么 */
  title: string;
  /** 可选的补充说明：为什么会这样、下一步做什么 */
  detail?: string;
  /** 建议跳转的路由，界面可据此渲染一个可点的出口 */
  actionRoute?: string;
  actionLabel?: string;
  /** 是否值得重试 */
  retryable?: boolean;
  /** 英文原文，仅供诊断与反馈，不直接展示 */
  debug?: string;
}

type Entry = Omit<LocalizedError, "debug">;

const BY_CODE: Record<string, Entry> = {
  // ---- Provider 侧失败（翻译请求真正打出去之后） ----
  PROVIDER_AUTH: {
    title: "API Key 被服务商拒绝",
    detail: "这个 Key 可能已失效、被撤销，或没有当前所选模型的权限。",
    actionRoute: "/system/providers",
    actionLabel: "去检查 Key",
  },
  PROVIDER_RATE_LIMIT: {
    title: "触发了服务商的频率限制",
    detail: "稍等片刻再重试；如果经常出现，可以在设置里调低并发任务数。",
    retryable: true,
  },
  PROVIDER_TIMEOUT: {
    title: "请求超时",
    detail: "网络较慢或服务商响应缓慢。重试通常可以解决。",
    retryable: true,
  },
  PROVIDER_NETWORK: {
    title: "网络连接失败",
    detail: "检查本机网络、代理设置，以及接口地址是否填对。",
    actionRoute: "/system/providers",
    actionLabel: "检查连接配置",
    retryable: true,
  },
  PROVIDER_SERVER: {
    title: "服务商返回了服务器错误",
    detail: "这是对方的问题，不是配置问题。稍后重试即可。",
    retryable: true,
  },
  PROVIDER_SCHEMA_MISMATCH: {
    title: "这一批返回内容没有通过格式校验",
    detail: "这不等于模型不支持结构化输出。已经成功保存的批次会保留，请先重试未完成部分；如果连续出现，再检查接口兼容性或换模型。",
    retryable: true,
  },
  PROVIDER_INVALID_PAYLOAD: {
    title: "发送给模型的请求被判定为无效",
    detail: "可能是单批文本过长，或参数超出该模型的允许范围。",
  },
  PROVIDER_INVALID_CONFIG: {
    title: "当前的连接配置无法使用",
    detail: "检查接口地址、模型名和传输方式是否匹配。",
    actionRoute: "/system/providers",
    actionLabel: "去修改配置",
  },
  PROVIDER_REDIRECT_BLOCKED: {
    title: "接口地址发生了不被允许的重定向",
    detail: "出于安全考虑，跨主机重定向会被拦截。请直接填写最终的接口地址。",
    actionRoute: "/system/providers",
    actionLabel: "去修改接口地址",
  },
  PROVIDER_UNKNOWN: {
    title: "服务商没有说明具体失败原因",
    detail: "项目和已导入文件都不用删除。打开“翻译 Provider”，选择这个项目使用的服务商并测试连接；连接正常就直接重试，仍失败再换模型。",
    actionRoute: "/system/providers",
    actionLabel: "打开翻译 Provider",
    retryable: true,
  },

  // ---- 任务 ----
  CANCELLED: { title: "操作已取消" },
  TRANSLATION_PAUSED: { title: "翻译已暂停", retryable: true },
  TASK_NOT_FOUND: { title: "找不到这个任务", detail: "它可能已经完成并被清理。" },
  TASK_EXECUTOR_UNAVAILABLE: { title: "任务执行器不可用", detail: "重启应用通常可以恢复。" },
  TASK_NOT_PAUSABLE: { title: "这个任务当前不能暂停" },
  TASK_ALREADY_RUNNING: { title: "任务已经在运行中" },
  INVALID_TASK_TRANSITION: { title: "任务状态已变化", detail: "刷新后再操作。" },
  INVALID_TASK_CONTROL: { title: "这个任务操作当前不可用" },
  INVALID_TASK: { title: "任务数据无效" },
  INVALID_TASK_REQUEST: { title: "任务请求无效" },
  USER_CONFIRMATION_REQUIRED: { title: "需要你确认后才能继续" },
  CONFIRMATION_REQUIRED: { title: "需要你确认后才能继续" },

  // ---- 资源库 ----
  RESOURCE_CONFLICT: { title: "资源在你编辑期间被改动过", detail: "重新打开后再保存，避免覆盖别处的修改。" },
  RESOURCE_SNAPSHOT_CONFLICT: { title: "项目引用的资源快照已过期", detail: "在项目里刷新资源快照后重试。" },
  INVALID_RESOURCE: { title: "资源内容不合法", detail: "检查 JSON 结构和必填字段。" },

  // ---- 凭据 ----
  CREDENTIAL_STORE_UNAVAILABLE: {
    title: "系统凭据存储不可用",
    detail: "Windows 凭据管理服务可能被禁用，API Key 无法安全保存。",
  },

  // ---- 媒体与语音识别 ----
  UNSUPPORTED: { title: "不支持这个格式" },
  CORRUPT_INPUT: { title: "文件已损坏或无法解析" },
  INVALID_ARTIFACT: { title: "生成的文件校验不通过" },
  TIMEOUT: { title: "操作超时", retryable: true },
  OUTPUT_TOO_LARGE: { title: "输出体积超出上限" },
  INVALID_ASR_RESULT: { title: "语音识别结果校验不通过" },
  NO_SPEECH_DETECTED: { title: "没有检测到可识别的语音", detail: "请确认音轨选择正确；如使用自定义 VAD，可降低阈值或切换为自动（推荐）。" },
  UNSEGMENTABLE_INPUT: { title: "识别时间戳无法满足字幕限制", detail: "个别识别词的时间戳可能异常；请重试识别，若持续出现可切换识别模型或确认音轨内容。" },
  PROCESS_FAILED: { title: "外部处理进程执行失败" },
  WORKER_CRASHED: { title: "后台进程意外退出", retryable: true },
  PERMISSION_DENIED: { title: "没有访问该文件或目录的权限" },
  DOWNLOAD_FAILED: { title: "下载失败", retryable: true },
  LENGTH_MISMATCH: { title: "下载文件大小与预期不符", detail: "可能是网络中断导致的不完整下载，重试即可。", retryable: true },
  HASH_MISMATCH: { title: "文件校验值与预期不符", detail: "出于安全考虑已拒绝使用。请重新下载。", retryable: true },
  DISK_FULL: {
    title: "磁盘空间不足",
    detail: "清理空间或在设置里改用有足够空间的目录后重试；已经保存的项目不会被删除。",
    actionRoute: "/system/settings",
    actionLabel: "查看存储设置",
    retryable: true,
  },
  INSTALL_FAILED: { title: "安装失败" },
  INVALID_ARCHIVE: { title: "压缩包无法解压或内容不合法" },
  CUDA_UNAVAILABLE: { title: "CUDA 不可用", detail: "当前设备策略无法启动语音识别；请检查 CUDA runtime，或切换到当前模型支持的设备。" },
  CUDA_INITIALIZATION_FAILED: {
    title: "CUDA 初始化或执行失败",
    detail: "请检查显卡驱动和 CUDA runtime；若当前模型支持，也可切换到 CPU 后重试。",
  },

};

/**
 * 通用码只能兜底，**绝不能**和上面那张表放在一起。
 *
 * 之前把 INVALID_INPUT / NOT_FOUND 等放进 BY_CODE，因为 BY_CODE 先于 BY_MESSAGE 查，
 * 导致所有业务错误统统塌缩成一句「输入不合法」——后端写的
 * 「翻译前需要先验证一次连接」这类可操作提示全被吃掉，用户完全不知道该干什么。
 * 这几条必须排在 message 匹配之后。
 */
const BY_GENERIC_CODE: Record<string, Entry> = {
  NOT_FOUND: { title: "找不到目标" },
  CONFLICT: { title: "数据在你操作期间被改动过", detail: "刷新后重试。" },
  NOT_AVAILABLE: { title: "该功能当前不可用" },
  INVALID_INPUT: { title: "输入或配置不符合要求", detail: "请检查本次操作使用的文件与设置后重试。" },
  INTERNAL: { title: "操作失败" },
};

/**
 * 按英文原文兜底。后端这些文案是稳定的字符串常量，不是拼接出来的，
 * 所以匹配特征子串是可靠的。
 */
const BY_MESSAGE: Array<[RegExp, Entry]> = [
  [
    /A required ASR component is not installed/i,
    {
      title: "本机语音识别还缺组件",
      detail: "语音识别需要「识别模型」和「运行时」两样都在位，缺任意一样都跑不起来。到识别模型页可以看到具体缺哪一样并就地安装。",
      actionRoute: "/system/asr",
      actionLabel: "去安装",
    },
  ],
  [
    /ASR (?:result failed validation|request is invalid)/i,
    {
      title: "语音识别没有产出可用结果",
      detail: "识别跑完了但结果不符合要求（常见于音轨几乎无人声、或选错了音轨）。回到转写阶段换一条音轨、或指定语言后重试。",
    },
  ],
  [
    /Filtered audio could not be prepared for speech recognition/i,
    { title: "过滤后的音频无法交给语音识别", detail: "请切回“保留歌曲/唱词”后重试；若持续出现，请反馈任务发生时间。" },
  ],
  [
    /Run a connection test for this exact Provider configuration/i,
    {
      title: "开始前需要先验证一次连接",
      detail: "服务商、模型、接口地址、传输方式这四项里只要改过任意一项，之前的验证结果就不再有效。验证只发一次很短的测试请求。",
      actionRoute: "/system/providers",
      actionLabel: "立即验证",
    },
  ],
  [
    /Provider is not available for translation|Provider is unavailable/i,
    {
      title: "当前服务商不能用于翻译",
      detail: "请换成一个已接入的服务商。",
      actionRoute: "/system/providers",
      actionLabel: "去更换",
    },
  ],
  [
    /Model is not available for this provider/i,
    {
      title: "这个模型不属于所选服务商",
      actionRoute: "/system/providers",
      actionLabel: "去重新选择",
    },
  ],
  [/Translation provider and model are required/i, { title: "还没有选择服务商和模型", actionRoute: "/system/providers", actionLabel: "去选择" }],
  [/At least one target language is required/i, { title: "至少要选择一种目标语言" }],
  [/Duplicate target languages are not allowed/i, { title: "目标语言不能重复" }],
  [/Project has no active source track/i, { title: "项目还没有可用的源字幕轨", detail: "先导入字幕，或对媒体做一次语音识别。" }],
  [/Extract embedded subtitles before editing targets/i, { title: "请先提取内嵌字幕，然后才能编辑译文" }],
  [/Only approved tracks without hard errors can be exported/i, { title: "只有通过校验且已批准的译文轨才能导出" }],
  [/Source track missing/i, { title: "找不到源字幕轨" }],
  [/Target track not found/i, { title: "找不到目标语言轨" }],
  [/Project not found/i, { title: "找不到这个项目", detail: "它可能已被移到回收站或删除。" }],
  [/Batch project not found/i, { title: "批量任务里有项目找不到了" }],
  [/Desktop persistence is unavailable in this runtime/i, { title: "这个功能只能在桌面应用里使用", detail: "浏览器预览不能读写本地文件，也不会真正发起翻译。" }],
  [/only available in desktop runtime|requires the desktop runtime/i, { title: "这个功能只能在桌面应用里使用" }],
  [/Subtitle import requires file bytes/i, { title: "读取字幕文件内容失败" }],
  [/Subtitle import did not create a project/i, { title: "字幕导入没有生成项目", detail: "文件可能是空的或格式不受支持。" }],
  [/(?:SRT|ASS\/SSA|VTT).+(?:invalid timestamp|timing is malformed)/i, { title: "字幕时间码格式无效", detail: "请修正报错字幕段的开始与结束时间后重新导入。" }],
  [/Invalid project id/i, { title: "项目标识不合法" }],
  [/Project storage is unavailable/i, { title: "本地数据库无法打开", detail: "数据库版本可能与当前应用不匹配。" }],
  [/Secure credential storage is unavailable/i, { title: "系统凭据存储不可用" }],
  [/Credential not found/i, { title: "还没有保存 API Key", actionRoute: "/system/providers", actionLabel: "去填写" }],
  [/Invalid credential request/i, { title: "凭据信息不合法" }],
  [/is not a supported field/i, { title: "请求里包含了不支持的字段" }],
  [/Desktop persistence failed/i, { title: "本地保存失败" }],
];

export interface RawIpcError {
  code?: string;
  message?: string;
  retryable?: boolean;
  details?: unknown;
}

export function localizeIpcError(error: RawIpcError | null | undefined): LocalizedError {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = typeof error?.message === "string" ? error.message : "";

  // 1) 专用错误码：语义明确，优先级最高
  const byCode = BY_CODE[code];
  if (byCode) {
    return { ...byCode, retryable: error?.retryable ?? byCode.retryable, debug: message || undefined };
  }

  // 2) 按后端英文原文匹配。必须排在通用码之前，否则可操作提示会被通用码吃掉
  for (const [pattern, entry] of BY_MESSAGE) {
    if (pattern.test(message)) {
      return { ...entry, retryable: error?.retryable ?? entry.retryable, debug: message };
    }
  }

  // 3) 已经是中文了就直接用（domain 层有一部分文案本来就是中文）
  if (/[一-龥]/.test(message)) {
    return { title: message, retryable: error?.retryable };
  }

  // 4) 通用码兜底：说不出具体原因，但至少给出分类。
  //
  // 这里以前把后端原文塞进 debug 就算完，于是同一个错误在任务账本里写着
  // 「A required ASR component is not installed · NOT_AVAILABLE」，在弹窗里
  // 只剩一句「该功能当前不可用」——用户看不到为什么。没有中文对照时，
  // 宁可把英文原文放到 detail 里，也比让用户对着一句泛化标题猜要好。
  const generic = BY_GENERIC_CODE[code];
  if (generic) {
    return {
      ...generic,
      detail: generic.detail ?? (message || undefined),
      retryable: error?.retryable ?? generic.retryable,
      debug: message || undefined,
    };
  }

  return {
    title: "操作失败",
    detail: "这是一个未归类的错误，请记录发生时间并通过诊断日志反馈。",
    retryable: error?.retryable,
    debug: message || code || undefined,
  };
}

/** 供只需要一行文字的旧调用点使用 */
export function localizeIpcErrorText(error: RawIpcError | null | undefined): string {
  const localized = localizeIpcError(error);
  return localized.detail ? `${localized.title}：${localized.detail}` : localized.title;
}
