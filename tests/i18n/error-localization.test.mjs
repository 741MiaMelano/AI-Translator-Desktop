import assert from "node:assert/strict";
import test from "node:test";
import { localizeIpcError, localizeIpcErrorText } from "../../src/i18n/errors.ts";

test("actionable backend messages survive a generic INVALID_INPUT code", () => {
  // 回归防护：曾经把 INVALID_INPUT 放进 BY_CODE，而 BY_CODE 先于 BY_MESSAGE 查，
  // 于是所有业务错误都塌缩成一句「输入不合法」，后端写的可操作提示全被吃掉。
  const localized = localizeIpcError({
    code: "INVALID_INPUT",
    message: "Run a connection test for this exact Provider configuration before translation",
  });

  assert.match(localized.title, /验证/);
  assert.equal(localized.actionRoute, "/system/providers");
  assert.ok(localized.actionLabel, "必须给出可点的出口");
  assert.notEqual(localized.title, "请求被拒绝");
});

test("every message pattern beats the generic code fallback", () => {
  const cases = [
    ["Provider is not available for translation", /不能用于翻译/],
    ["Model is not available for this provider", /不属于所选服务商/],
    ["Project has no active source track; extract embedded subtitles first", /源字幕轨/],
    ["Source track missing", /源字幕轨/],
    ["SRT cue has an invalid timestamp", /字幕时间码/],
    ["At least one target language is required", /目标语言/],
    ["Filtered audio could not be prepared for speech recognition", /过滤后的音频/],
  ];
  for (const [message, expected] of cases) {
    const localized = localizeIpcError({ code: "INVALID_INPUT", message });
    assert.match(localized.title, expected, message);
  }
});

test("provider failure codes keep their own actionable text", () => {
  const auth = localizeIpcError({ code: "PROVIDER_AUTH", message: "401 unauthorized" });
  assert.match(auth.title, /API Key/);
  assert.equal(auth.actionRoute, "/system/providers");

  const rate = localizeIpcError({ code: "PROVIDER_RATE_LIMIT", message: "429", retryable: true });
  assert.equal(rate.retryable, true);

  const unknown = localizeIpcError({ code: "PROVIDER_UNKNOWN", message: "unclassified" });
  assert.match(unknown.detail, /不用删除/);
  assert.equal(unknown.actionRoute, "/system/providers");
  assert.equal(unknown.retryable, true);
});

test("generic codes still provide a fallback when nothing else matches", () => {
  const localized = localizeIpcError({ code: "INVALID_INPUT", message: "totally unknown backend text" });
  assert.equal(localized.title, "输入或配置不符合要求");
  assert.equal(localized.debug, "totally unknown backend text");
  assert.doesNotMatch(localizeIpcErrorText({ code: "INVALID_INPUT", message: "totally unknown backend text" }), /下方原文/);
});

test("chinese messages pass through untouched", () => {
  assert.equal(localizeIpcErrorText({ code: "INTERNAL", message: "项目保存失败，翻译未开始" }), "项目保存失败，翻译未开始");
});

test("no English leaks into the user-facing text for known errors", () => {
  const localized = localizeIpcError({
    code: "INVALID_INPUT",
    message: "Run a connection test for this exact Provider configuration before translation",
  });
  const visible = `${localized.title}${localized.detail ?? ""}${localized.actionLabel ?? ""}`;
  assert.doesNotMatch(visible, /[A-Za-z]{4,}/, `用户可见文字里不应出现英文单词：${visible}`);
});

test("disk-full errors explain recovery without implying data loss", () => {
  const localized = localizeIpcError({ code: "DISK_FULL", message: "There is not enough disk space", retryable: true });
  assert.equal(localized.title, "磁盘空间不足");
  assert.match(localized.detail, /已经保存的项目不会被删除/);
  assert.equal(localized.actionRoute, "/system/settings");
  assert.equal(localized.retryable, true);
});

test("CUDA errors never promise a CPU fallback", () => {
  const localized = localizeIpcError({ code: "CUDA_UNAVAILABLE", message: "Qwen3-ASR Preview requires CUDA" });
  assert.doesNotMatch(localized.detail, /将使用 CPU/);
  assert.match(localized.detail, /设备策略/);
  const initialization = localizeIpcError({ code: "CUDA_INITIALIZATION_FAILED", message: "Vocal separation CUDA execution failed" });
  assert.doesNotMatch(initialization.detail, /已回退|自动回退|将使用 CPU/);
  assert.match(initialization.detail, /CUDA runtime/);
});

test("an unmatched backend reason is surfaced, never swallowed into debug only", () => {
  // 这就是用户报的那个 bug：同一个错误在任务账本里写着
  // 「A required ASR component is not installed · NOT_AVAILABLE」，
  // 在弹窗里却只剩一句「该功能当前不可用」。
  const asr = localizeIpcError({ code: "NOT_AVAILABLE", message: "A required ASR component is not installed" });
  assert.match(asr.title, /语音识别/);
  assert.match(asr.detail ?? "", /识别模型.*运行时|运行时.*识别模型/);
  assert.equal(asr.actionRoute, "/system/asr");
  assert.ok(asr.actionLabel);

  // 没有中文对照时也不能只给泛化标题：原文要出现在 detail 里。
  const unknown = localizeIpcError({ code: "NOT_AVAILABLE", message: "Some brand new backend reason" });
  assert.equal(unknown.title, "该功能当前不可用");
  assert.equal(unknown.detail, "Some brand new backend reason");
  assert.match(localizeIpcErrorText(unknown === null ? null : { code: "NOT_AVAILABLE", message: "Some brand new backend reason" }), /Some brand new backend reason/);

  // 已有 detail 的通用码不被原文覆盖
  const invalid = localizeIpcError({ code: "INVALID_INPUT", message: "raw english" });
  assert.match(invalid.detail ?? "", /请检查/);
});
