import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { BatchImportAmbiguity, SubtitleEncodingChoice } from "../contracts/desktop-api";
import { TARGET_LANGUAGE_OPTIONS } from "../domain/workspace";
import {
  OUTPUT_FORMAT_OPTIONS,
  PROVIDER_OPTIONS,
  SOURCE_LANGUAGE_OPTIONS,
  STYLE_GUIDE_NONE,
  getTranslationModelOptions,
  useWorkspace,
} from "../state/WorkspaceContext";
import { useFrontend } from "./state";
import { Icon } from "./visuals";
import { formatUiDateTime } from "./format";

const ACCEPTED_FILES = ".mkv,.mp4,.mov,.avi,.webm,.wav,.mp3,.m4a,.srt,.ass,.ssa,.vtt";

function mediaKindLabel(value: string) {
  return ({ video: "视频", audio: "音频", subtitle: "字幕" } as Record<string, string>)[value] ?? value;
}

function encodingLabel(value: SubtitleEncodingChoice) {
  return value === "shift_jis" ? "Shift-JIS" : value.toUpperCase();
}

function safeProbeSummary(probe: Record<string, unknown>) {
  const format = probe.format && typeof probe.format === "object"
    ? probe.format as Record<string, unknown>
    : null;
  const values = [
    typeof format?.format_name === "string" ? format.format_name.toUpperCase() : null,
    typeof format?.duration === "string" && Number.isFinite(Number(format.duration))
      ? `${Math.round(Number(format.duration))} 秒`
      : null,
  ].filter(Boolean);
  return values.join(" · ") || "本机探测完成";
}

function workflowText(files: Array<{ mediaKind: string }>) {
  const hasMedia = files.some((file) => file.mediaKind !== "subtitle");
  const hasSubtitle = files.some((file) => file.mediaKind === "subtitle");
  if (!hasMedia) return "读取字幕 → 翻译 → QA";
  if (hasSubtitle) return "使用已选字幕 → 翻译 → QA";
  return "探测媒体 → 提取字幕或本机 ASR → 翻译 → QA";
}

function WizardHeader({ step, onCancel }: { step: number; onCancel: () => void }) {
  return (
    <header className="wizard-header">
      <ol aria-label="导入进度">
        {["选择素材", "确认方案", "创建项目"].map((label, index) => (
          <li key={label} className={index === step ? "active" : index < step ? "is-done" : ""} aria-current={index === step ? "step" : undefined}>
            <span>{index < step ? <Icon name="check"/> : index + 1}</span>{label}
          </li>
        ))}
      </ol>
      <button type="button" className="text-button" onClick={onCancel}>取消</button>
    </header>
  );
}

function AmbiguityCard({ ambiguity }: { ambiguity: BatchImportAmbiguity }) {
  const workspace = useWorkspace();
  const session = workspace.batchSession!;
  const file = session.files.find((item) => item.id === ambiguity.fileId);
  if (ambiguity.kind === "subtitle_encoding") {
    return (
      <section className="import-decision" aria-labelledby={`encoding-${ambiguity.fileId}`}>
        <span className="decision-mark"><Icon name="warning"/></span>
        <div><strong id={`encoding-${ambiguity.fileId}`}>确认“{file?.name ?? "字幕"}”的编码</strong><p>后端无法安全自动判断；选择错误会使字幕文字损坏。</p></div>
        <div className="decision-actions">
          {ambiguity.encodingCandidates.map((encoding) => (
            <button type="button" className="btn btn-secondary" key={encoding} onClick={() => workspace.resolveBatchSubtitleEncoding(ambiguity.fileId, encoding)}>{encodingLabel(encoding)}</button>
          ))}
        </div>
      </section>
    );
  }
  return (
    <section className="import-decision" aria-labelledby={`match-${ambiguity.fileId}`}>
      <span className="decision-mark"><Icon name="warning"/></span>
      <div><strong id={`match-${ambiguity.fileId}`}>“{file?.name ?? "字幕"}”属于哪个媒体？</strong><p>文件名匹配到多个候选，必须由你确认，不会自动猜测。</p></div>
      <div className="decision-actions">
        {ambiguity.candidateMediaFileIds.map((candidateId) => {
          const candidate = session.files.find((item) => item.id === candidateId);
          return <button type="button" className="btn btn-secondary" key={candidateId} onClick={() => workspace.resolveBatchMediaMatch(ambiguity.fileId, candidateId)}>{candidate?.name ?? "候选媒体"}</button>;
        })}
        <button type="button" className="btn btn-secondary" onClick={() => workspace.resolveBatchMediaMatch(ambiguity.fileId, null)}>作为独立字幕项目</button>
      </div>
    </section>
  );
}

export function ImportPage() {
  const workspace = useWorkspace();
  const app = useFrontend();
  const location = useLocation();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const consumedDropRef = useRef<unknown>(null);
  const [step, setStep] = useState(workspace.batchSession ? 1 : 0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 默认手动确认翻译：翻译是唯一花钱的一步，不该在用户没点头的情况下发生。
  const [autoTranslate, setAutoTranslate] = useState(false);
  const [duplicate, setDuplicate] = useState<{ file: File; projectId: string; title: string; updatedAt: string } | null>(null);
  const [copyTitlePending, setCopyTitlePending] = useState(false);
  const session = workspace.batchSession;

  useEffect(() => {
    if (!session && step > 0) setStep(0);
    if (session && step === 0) setStep(1);
  }, [session, step]);

  useEffect(() => {
    if (!session || !copyTitlePending || !session.groups[0]) return;
    workspace.updateBatchGroupTitle(session.groups[0].id, `${session.groups[0].title} 副本`);
    setCopyTitlePending(false);
  }, [copyTitlePending, session, workspace]);

  const modelOptions = useMemo(() => {
    if (!session) return [];
    const runtime = workspace.capabilities.providers.find((provider) => provider.name === session.defaults.provider);
    if (runtime?.models.length) {
      return runtime.models.includes(session.defaults.model)
        ? runtime.models
        : [session.defaults.model, ...runtime.models];
    }
    try {
      return [...getTranslationModelOptions(session.defaults.provider)];
    } catch {
      return session.defaults.model ? [session.defaults.model] : [];
    }
  }, [session, workspace.capabilities.providers]);

  const cancel = () => {
    if (session) workspace.discardBatchSession();
    app.play("navigate");
    navigate("/");
  };

  const prepare = async (files: File[], duplicateCopy = false) => {
    if (!workspace.isDesktop) {
      setLocalError("浏览器只用于预览布局；请在桌面应用中选择本地文件。");
      return;
    }
    setBusy(true);
    setLocalError(null);
    if (duplicateCopy) setCopyTitlePending(true);
    const ready = await workspace.createBatchSession(files);
    setBusy(false);
    if (!ready) {
      setCopyTitlePending(false);
      setLocalError(workspace.saveError ?? "文件探测失败，请检查格式后重试。");
      return;
    }
    app.play("success");
    setStep(1);
  };

  const handleFiles = (selected: FileList | File[]) => {
    const files = Array.from(selected);
    if (files.length === 0) return;
    const existing = files.length === 1
      ? workspace.projects.find((project) => !project.trashedAt && project.sourceFileName.toLocaleLowerCase() === files[0].name.toLocaleLowerCase())
      : null;
    if (existing) {
      setDuplicate({ file: files[0], projectId: existing.id, title: existing.title, updatedAt: existing.updatedAt });
      app.play("warning");
      return;
    }
    setDuplicate(null);
    void prepare(files);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  useEffect(() => {
    const routeState = location.state as { droppedFiles?: File[] } | null;
    if (!routeState?.droppedFiles?.length || consumedDropRef.current === routeState) return;
    consumedDropRef.current = routeState;
    navigate(location.pathname, { replace: true, state: null });
    handleFiles(routeState.droppedFiles);
  }, [location.pathname, location.state]);

  const commit = async () => {
    if (!session || session.ambiguities.length > 0) return;
    setBusy(true);
    setLocalError(null);
    const batch = await workspace.commitBatchSession();
    setBusy(false);
    if (!batch) {
      setLocalError(workspace.saveError ?? "项目没有创建，请检查方案后重试。");
      return;
    }
    // 批次提交的契约里没有这一项，所以创建完成后走已有的项目配置通道逐个写入。
    if (autoTranslate) {
      for (const projectId of batch.projectIds) workspace.updateProjectConfig(projectId, { autoTranslate: true });
    }
    await app.refresh();
    app.play("success");
    navigate(batch.projectIds.length === 1 ? `/projects/${batch.projectIds[0]}` : "/batch/review", { replace: true });
  };

  const translationReadiness = app.readiness.data?.global.capabilities.find((capability) => capability.id === "translation");

  return (
    <div className="page-stage import-page" data-fr02-view="import">
      <WizardHeader step={step} onCancel={cancel}/>
      {step === 0 ? (
        <section className="wizard-sheet reveal-sheet production-wizard-sheet">
          <div className="wizard-copy"><h1>先选择一个素材</h1><p>文件只交给桌面主进程探测；渲染层不会拿到绝对路径。</p></div>
          <input ref={inputRef} className="production-file-input" type="file" multiple accept={ACCEPTED_FILES} onChange={(event) => { handleFiles(event.currentTarget.files ?? []); event.currentTarget.value = ""; }}/>
          <button
            type="button"
            className={`drop-zone ${dragging ? "is-dragging" : ""}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            disabled={busy || !workspace.isDesktop}
          >
            <span className="drop-symbol"><Icon name="upload"/><i/></span><strong>{busy ? "正在本机探测文件" : "把文件拖到这里"}</strong><p>或点击选择视频、音频、字幕；可一次选择多个文件</p><em>MP4 · MKV · MP3 · WAV · SRT · VTT · ASS · SSA</em>
          </button>
          {!workspace.isDesktop ? <div className="import-runtime-note"><Icon name="warning"/><span>当前是浏览器只读预览，文件选择与项目创建已禁用。</span></div> : null}
          {duplicate ? (
            <section className="import-decision duplicate-decision" aria-labelledby="duplicate-heading">
              <span className="decision-mark"><Icon name="warning"/></span><div><strong id="duplicate-heading">检测到重复导入</strong><p>“{duplicate.file.name}”已匹配到项目“{duplicate.title}”（{formatUiDateTime(duplicate.updatedAt)}）。</p></div>
              <div className="decision-actions"><button type="button" className="btn btn-primary" onClick={() => navigate(`/projects/${duplicate.projectId}`)}>继续现有项目</button><button type="button" className="btn btn-secondary" onClick={() => { const file = duplicate.file; setDuplicate(null); void prepare([file], true); }}>创建独立副本</button><button type="button" className="text-button" onClick={() => setDuplicate(null)}>换一个文件</button></div>
            </section>
          ) : null}
          {localError || workspace.saveError ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>无法准备导入</strong><p>{workspace.saveError ?? localError}</p></div></div> : null}
        </section>
      ) : session && step === 1 ? (
        <section className="wizard-sheet reveal-sheet production-wizard-sheet">
          <div className="wizard-copy"><h1>确认真实翻译方案</h1><p>探测结果、歧义和可用资源均来自本机服务；创建项目不会调用 Provider。</p></div>
          <div className="file-diagnosis production-file-diagnosis">
            <div className="diagnosis-files">
              {session.files.map((file) => <div key={file.id}><span className="file-kind">{mediaKindLabel(file.mediaKind)}</span><strong title={file.name}>{file.name}</strong><small>{safeProbeSummary(file.probe ?? {})}</small></div>)}
            </div>
            <div className="diagnosis-route"><span className="done"><Icon name="check"/> 已探测素材</span><i/><span className="current"><b>下一步</b> 确认方案</span><i/><span>创建本机项目</span></div>
          </div>

          {session.ambiguities.map((ambiguity) => <AmbiguityCard key={`${ambiguity.kind}-${ambiguity.fileId}`} ambiguity={ambiguity}/>)}

          <div className="import-groups">
            {session.groups.map((group, index) => <label key={group.id}><span>项目 {index + 1} 名称 · {group.confidence === "high" ? "高置信分组" : "需要复核"}</span><input value={group.title} onChange={(event) => workspace.updateBatchGroupTitle(group.id, event.target.value)} maxLength={120}/></label>)}
          </div>

          <div className="choice-fields production-choice-fields">
            <label><span>原始语言</span><select value={session.defaults.sourceLanguage} onChange={(event) => workspace.updateBatchSessionDefaults({ sourceLanguage: event.target.value })}>{SOURCE_LANGUAGE_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label>
            <fieldset><legend>翻译为</legend><div className="language-chips">{TARGET_LANGUAGE_OPTIONS.map((language) => { const selected = session.defaults.targetLanguages.includes(language); return <button type="button" key={language} className={selected ? "is-active" : ""} aria-pressed={selected} disabled={selected && session.defaults.targetLanguages.length === 1} onClick={() => workspace.updateBatchSessionDefaults({ targetLanguages: selected ? session.defaults.targetLanguages.filter((value) => value !== language) : [...session.defaults.targetLanguages, language] })}>{language}</button>; })}</div></fieldset>
            <label><span>Provider</span><select value={session.defaults.provider} onChange={(event) => workspace.updateBatchSessionDefaults({ provider: event.target.value })}>{PROVIDER_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label>
            <label><span>模型</span><select value={session.defaults.model} onChange={(event) => workspace.updateBatchSessionDefaults({ model: event.target.value })}>{modelOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
            <details className="advanced-row production-import-advanced"><summary>高级选项：资源与输出 <Icon name="chevron"/></summary><div className="advanced-import-grid"><label><span>术语表</span><select value={session.defaults.glossary} onChange={(event) => workspace.updateBatchSessionDefaults({ glossary: event.target.value })}>{[...workspace.glossaryOptions].map((value) => <option key={value}>{value}</option>)}</select></label><label><span>风格指南</span><select value={session.defaults.styleGuide} onChange={(event) => workspace.updateBatchSessionDefaults({ styleGuide: event.target.value })}>{workspace.styleGuideOptions.map((value) => <option key={value} value={value}>{value === STYLE_GUIDE_NONE ? "不使用风格指南" : value}</option>)}</select></label><label><span>默认导出格式</span><select value={session.defaults.outputFormat} onChange={(event) => workspace.updateBatchSessionDefaults({ outputFormat: event.target.value })}>{OUTPUT_FORMAT_OPTIONS.map((value) => <option key={value}>{value}</option>)}</select></label><p>后端已废弃项目预算字段，因此这里不显示预算输入或假估算。</p></div></details>
          </div>

          {translationReadiness && !translationReadiness.available ? <div className="import-runtime-note is-attention"><Icon name="warning"/><span>翻译服务当前未就绪：{translationReadiness.reason ?? "尚未配置"}。仍可创建本机项目，真正开始翻译时会再次阻止并给出恢复动作。</span></div> : null}
          <div className="wizard-actions"><button type="button" className="btn btn-secondary" onClick={() => { workspace.discardBatchSession(); setStep(0); }}>重新选择</button><button type="button" className="btn btn-primary" disabled={session.ambiguities.length > 0 || session.groups.some((group) => !group.title.trim())} onClick={() => setStep(2)}>确认方案 <Icon name="arrow"/></button></div>
        </section>
      ) : session ? (
        <section className="wizard-sheet reveal-sheet production-wizard-sheet">
          <div className="ready-symbol"><Icon name="check"/><i/></div>
          <div className="wizard-copy centered"><h1>项目可以创建了</h1><p>这一步只写入本机数据库和项目文件；不会发送字幕、不会调用模型、不会产生费用。</p></div>
          <div className="ready-summary"><div><span>素材</span><strong>{session.files.map((file) => file.name).join("、")}</strong></div><div><span>流程</span><strong>{workflowText(session.files)}</strong></div><div><span>目标语言</span><strong>{session.defaults.targetLanguages.join("、")}</strong></div><div><span>Provider / 模型</span><strong>{session.defaults.provider} · {session.defaults.model}</strong></div></div>
          <div className="consent-row production-local-confirm"><Icon name="check"/><span><strong>当前动作仅创建本机项目</strong><small>不会发送字幕、不会调用模型、不会产生费用。</small></span></div>

          {/* 一个开关，一句话说清两种模式的差别。翻译是唯一花钱的一步，所以它是唯一
              需要用户提前决定"要不要自动"的一步。默认手动。 */}
          <label className="auto-translate-choice">
            <input type="checkbox" checked={autoTranslate} onChange={(event) => setAutoTranslate(event.target.checked)}/>
            <span>
              <strong>{autoTranslate ? "全自动：一路跑到译完" : "手动确认翻译（默认）"}</strong>
              <small>
                {autoTranslate
                  ? `点"开始处理"后会连翻译一起做完，中途不再问你——会向 ${session.defaults.provider} 发送请求并产生费用。`
                  : `本机的探测、转写、分段照常自动完成；到翻译这一步会停下来，等你在翻译阶段点一次"开始翻译"才会向 ${session.defaults.provider} 发请求。`}
              </small>
            </span>
          </label>
          {localError || workspace.saveError ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>项目尚未创建</strong><p>{workspace.saveError ?? localError}</p></div></div> : null}
          <div className="wizard-actions"><button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>上一步</button><button type="button" className="btn btn-primary" onClick={() => void commit()} disabled={busy}>{busy ? "正在创建" : "创建项目并进入工作区"} <Icon name="arrow"/></button></div>
        </section>
      ) : null}
    </div>
  );
}
