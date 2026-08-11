import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileText,
  LoaderCircle,
  Play,
  PlugZap,
  Trash2,
  UploadCloud,
} from "lucide-react";
import Badge from "../components/ui/Badge";
import BottomActionBar from "../components/ui/BottomActionBar";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import Input from "../components/ui/Input";
import MediaPreviewFrame from "../components/feature/MediaPreviewFrame";
import AutomaticWorkflowBanner from "../components/feature/AutomaticWorkflowBanner";
import PageHeader from "../layout/PageHeader";
import Select from "../components/ui/Select";
import {
  deriveProjectStatusSummary,
  formatMediaKind,
  TARGET_LANGUAGE_OPTIONS,
} from "../domain/workspace";
import {
  OUTPUT_FORMAT_OPTIONS,
  PROVIDER_OPTIONS,
  SOURCE_LANGUAGE_OPTIONS,
  optionsWithCurrent,
  useWorkspace,
} from "../state/WorkspaceContext";
import { useModelOptionsFor } from "../state/use-model-options";
import type { StartTranslateController } from "./start-translate-controller";

const CHIP_BASE =
  "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[6px] border px-3 text-[12.5px] transition disabled:cursor-not-allowed disabled:opacity-45";
const CHIP_ON = "metal-gold border-transparent font-medium";
const CHIP_OFF =
  "border-line-strong bg-card text-[var(--color-text-main)] hover:border-gold hover:text-gold-dark";

function TargetLanguageSelector({ controller }: { controller: StartTranslateController }) {
  const selected = controller.currentConfig.targetLanguages;
  return (
    <div>
      <p className="mb-1 text-[12.5px] text-[var(--color-text-muted)]">目标语言</p>
      <div role="group" aria-label="目标语言" className="flex flex-wrap gap-1.5">
        {TARGET_LANGUAGE_OPTIONS.map((language) => {
          const active = selected.includes(language);
          const isLastSelected = active && selected.length === 1;
          return (
            <button
              key={language}
              type="button"
              aria-pressed={active}
              disabled={isLastSelected}
              title={isLastSelected ? "至少保留一个目标语言；先添加其它语言再取消这一个" : undefined}
              onClick={() => controller.toggleTargetLanguage(language)}
              className={`${CHIP_BASE} ${active ? CHIP_ON : CHIP_OFF}`}
            >
              {language}
            </button>
          );
        })}
      </div>
      {controller.targetLanguageError ? (
        <p role="alert" className="mt-1.5 text-[11.5px] leading-5 text-stop">
          {controller.targetLanguageError}
        </p>
      ) : null}
    </div>
  );
}

function ImportDropzone({ controller }: { controller: StartTranslateController }) {
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        controller.setIsDragging(true);
      }}
      onDragLeave={() => controller.setIsDragging(false)}
      onDrop={controller.handleDrop}
      className={`flex w-full flex-col items-center gap-3 rounded-[10px] border border-dashed px-6 py-12 text-center transition ${
        controller.isDragging ? "border-gold bg-gold-wash" : "border-line-strong bg-card hover:border-gold"
      }`}
    >
      <input
        ref={controller.inputRef}
        type="file"
        multiple
        accept=".mkv,.mp4,.mov,.webm,.wav,.mp3,.m4a,.aac,.flac,.srt,.ass,.ssa,.vtt"
        className="hidden"
        onChange={(event) => {
          controller.handleFiles(event.target.files);
          event.currentTarget.value = "";
        }}
      />
      <span className="flex h-12 w-12 items-center justify-center rounded-[10px] bg-gold-wash text-gold-dark">
        <UploadCloud size={22} />
      </span>
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text-main)]">把文件拖到这里</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-[var(--color-text-muted)]">
          支持常见视频、音频以及 SRT / ASS / SSA / VTT 字幕；可一次混合选择多个文件。
        </p>
      </div>
      <Button variant="primary" data-testid="import-files" onClick={controller.openFilePicker}>
        导入文件
      </Button>
    </div>
  );
}

function PendingImportCards({ controller }: { controller: StartTranslateController }) {
  const pending = controller.pendingDuplicateImport;
  return (
    <>
      {pending ? (
        <Card title="检测到重复导入" description="请选择继续现有项目，或创建一个独立副本。" actions={<Badge tone="gold">需要确认</Badge>}>
          <div className="flex flex-wrap items-center gap-3">
            <AlertTriangle size={16} className="shrink-0 text-gold-dark" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium" title={pending.file.name}>{pending.file.name}</p>
              <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
                已匹配到「{pending.existingProjectTitle}」，更新于 {pending.existingProjectUpdatedAt}。
              </p>
            </div>
            <Button variant="primary" onClick={controller.continueExistingProject}>继续现有项目</Button>
            <Button variant="outline" onClick={controller.createDuplicateCopy}>新建副本</Button>
          </div>
        </Card>
      ) : null}
      {controller.encodingConfirmation ? (
        <Card
          title="选择字幕编码"
          description={`无法自动判断 ${controller.encodingConfirmation.fileName} 的文本编码。`}
          actions={<Badge tone="gold">需要确认</Badge>}
        >
          <div className="flex flex-wrap gap-2">
            {controller.encodingConfirmation.candidates.map((encoding) => (
              <Button key={encoding} variant="primary" onClick={() => void controller.confirmSubtitleEncoding(encoding)}>
                {encoding === "shift_jis" ? "Shift-JIS" : encoding.toUpperCase()}
              </Button>
            ))}
            <Button variant="outline" onClick={controller.cancelSubtitleEncoding}>取消导入</Button>
          </div>
        </Card>
      ) : null}
    </>
  );
}

function ModelStatusRow({ controller }: { controller: StartTranslateController }) {
  const { capabilities } = useWorkspace();
  const provider = capabilities.providers.find((entry) => entry.name === controller.currentConfig.provider);
  const ready = provider?.status === "ready";
  const configured = Boolean(provider?.credentialConfigured);
  return (
    <section className="flex flex-wrap items-center gap-3 border-y border-line py-3">
      <span className={`h-2 w-2 rounded-full ${ready ? "bg-ok" : configured ? "bg-warn" : "bg-stop"}`} />
      <div className="min-w-0 flex-1">
        <h2 className="text-[12.5px] font-semibold">翻译模型</h2>
        <p className="truncate text-[11.5px] text-[var(--color-text-muted)]">
          {controller.currentConfig.provider} · {controller.currentConfig.model}
        </p>
      </div>
      <span className="text-[11.5px] text-[var(--color-text-muted)]">
        {ready ? "连接正常" : configured ? "已保存，使用时检查" : "尚未连接"}
      </span>
      <Button variant="ghost" size="sm" onClick={() => controller.navigate("/capabilities")}>
        {configured ? "更改" : "连接"}
      </Button>
    </section>
  );
}

function FirstRunReadiness({ controller }: { controller: StartTranslateController }) {
  const capabilities = controller.firstRunReadiness?.global.capabilities ?? [];
  const rows = [
    {
      id: "translation",
      title: "翻译模型",
      scope: "必要",
      readyText: "已经连接，可以直接翻译字幕",
      pendingText: "必须先连接一个翻译服务",
      actionLabel: "连接模型",
      actionRoute: "/capabilities",
    },
    {
      id: "video_export",
      title: "视频 / 音频处理",
      scope: "媒体文件",
      readyText: "FFmpeg 已内置并通过校验",
      pendingText: "本机媒体组件不可用",
      actionLabel: "查看环境",
      actionRoute: "/settings",
    },
    {
      id: "asr",
      title: "语音转字幕",
      scope: "按需",
      readyText: "本地语音识别已经就绪",
      pendingText: "仅在视频或音频没有字幕时需要",
      actionLabel: "按需安装",
      actionRoute: "/capabilities?tab=asr",
    },
  ].map((row) => ({
    ...row,
    capability: capabilities.find((item) => item.id === row.id),
  }));
  const readyCount = rows.filter(({ capability }) => capability?.available).length;

  return (
    <Card
      title="首次使用检查"
      description="字幕翻译只需连接模型；视频和音频能力会按文件类型自动使用。"
      actions={<Badge tone={readyCount === rows.length ? "green" : "gold"}>{readyCount} / {rows.length} 已就绪</Badge>}
      data-testid="first-run-readiness"
    >
      <div className="grid gap-2 lg:grid-cols-3">
        {rows.map(({ id, title, scope, readyText, pendingText, actionLabel, actionRoute, capability }) => {
          const ready = capability?.available === true;
          const loading = !capability && !controller.firstRunReadinessError;
          const Icon = loading ? LoaderCircle : ready ? CheckCircle2 : AlertTriangle;
          return (
            <section key={id} data-testid={`readiness-${id}`} className="rounded-[6px] border border-line bg-card-soft px-3 py-2.5">
              <div className="flex items-center gap-2">
                <Icon size={15} className={`shrink-0 ${loading ? "animate-spin text-[var(--color-text-muted)]" : ready ? "text-ok" : "text-warn"}`} />
                <h2 className="min-w-0 flex-1 text-[12.5px] font-semibold">{title}</h2>
                <Badge tone={scope === "必要" ? "gold" : "gray"}>{scope}</Badge>
              </div>
              <p className="mt-1.5 min-h-10 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
                {loading ? "正在检查本机环境…" : ready ? readyText : capability?.reason ?? pendingText}
              </p>
              {!loading && !ready ? (
                <Button className="mt-1" variant="secondary" size="sm" onClick={() => controller.navigate(actionRoute)}>
                  {actionLabel}
                </Button>
              ) : null}
            </section>
          );
        })}
      </div>
      {controller.firstRunReadinessError ? (
        <p role="alert" className="mt-2 text-[11.5px] leading-5 text-stop">
          环境检查失败：{controller.firstRunReadinessError}
        </p>
      ) : null}
    </Card>
  );
}

function RecentProjects({ controller }: { controller: StartTranslateController }) {
  return (
    <section aria-labelledby="recent-projects-title">
      <div className="flex items-center gap-3 border-b border-line py-2.5">
        <h2 id="recent-projects-title" className="text-[13px] font-semibold">最近项目</h2>
        <Button className="ml-auto" variant="ghost" size="sm" onClick={() => controller.navigate("/workspace")}>
          查看全部项目
        </Button>
      </div>
      {controller.recentProjects.length ? (
        <div className="divide-y divide-line">
          {controller.recentProjects.map((project) => {
            const summary = deriveProjectStatusSummary(project);
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => controller.navigate(
                  project.lifecycle === "draft" ? `/?projectId=${encodeURIComponent(project.id)}` : `/projects/${project.id}`,
                )}
                className="flex w-full items-center gap-3 py-3 text-left transition hover:text-gold-dark"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.title}</span>
                <span className="hidden text-[11.5px] text-[var(--color-text-muted)] sm:inline">
                  {project.config.sourceLanguage} → {project.config.targetLanguages.join(" / ")}
                </span>
                <Badge tone={summary.tone}>{summary.label}</Badge>
                <ChevronRight size={15} className="shrink-0 text-[var(--color-text-muted)]" />
              </button>
            );
          })}
        </div>
      ) : (
        <p className="py-5 text-[12.5px] text-[var(--color-text-muted)]">导入第一个文件后，项目会出现在这里。</p>
      )}
    </section>
  );
}

function SourcePreview({ controller }: { controller: StartTranslateController }) {
  const project = controller.draftProject!;
  if (project.noSourceMedia) {
    return (
      <div className="flex aspect-[16/9] flex-col items-center justify-center gap-1.5 rounded-[10px] border border-line bg-card-soft text-center">
        <FileText size={22} className="text-gold-dark" />
        <p className="text-[13px] font-medium">纯字幕项目</p>
      </div>
    );
  }
  return (
    <MediaPreviewFrame className="aspect-[16/9] rounded-[10px] border border-line">
      <div className="absolute bottom-3 left-3 right-3 rounded-[6px] bg-black/55 px-3 py-2 text-left">
        <p className="truncate text-[12.5px] font-semibold text-white" title={project.sourceFileName}>
          {project.sourceFileName}
        </p>
      </div>
    </MediaPreviewFrame>
  );
}

function StartBlockNotice({ controller }: { controller: StartTranslateController }) {
  const block = controller.startBlock;
  if (!block || !controller.draftProject) return null;
  const sourceQuality = controller.sourceQuality;
  return (
    <div role="status" className="rounded-[6px] border border-line bg-warn-wash px-3 py-2 text-[11.5px] leading-5">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" />
        <span>{block.hint}</span>
      </div>
      {sourceQuality ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {block.actionRoute ? (
            <Button size="sm" variant="outline" onClick={() => controller.navigate(block.actionRoute!)}>
              检查源字幕
            </Button>
          ) : null}
          {!controller.draftProject.noSourceMedia ? (
            <Button size="sm" variant="outline" onClick={() => controller.navigate(`/projects/${controller.draftProject!.id}?focus=asr`)}>
              用媒体重新识别
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void controller.start({ allowUnsafeSource: true })}>
            仍使用原时间轴继续
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PreparedFile({ controller }: { controller: StartTranslateController }) {
  const project = controller.draftProject!;
  return (
    <section className="min-w-0 space-y-3">
      <SourcePreview controller={controller} />
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-semibold" title={project.title}>{project.title}</h2>
          <Badge tone="blue">{formatMediaKind(project.mediaKind)}</Badge>
        </div>
        <p className="mt-1 truncate text-[12.5px] text-[var(--color-text-muted)]" title={project.sourceFileName}>
          {project.sourceFileName} · {controller.draftSegments.length} 段字幕
        </p>
      </div>
      <StartBlockNotice controller={controller} />
    </section>
  );
}

function MissingProject({ controller }: { controller: StartTranslateController }) {
  return (
    <Card title="找不到这个项目" description="链接里指定的项目已经不在活动列表里。">
      <EmptyState
        icon={<AlertTriangle size={20} />}
        title="该项目不存在或已被丢弃"
        description="这里不会自动换成另一个项目，避免误改配置或误发起付费翻译。"
        action={<Button variant="secondary" onClick={() => controller.navigate("/workspace")}>查看项目</Button>}
      />
    </Card>
  );
}

function ConnectionPrerequisite({ controller }: { controller: StartTranslateController }) {
  const { capabilities } = useWorkspace();
  const provider = capabilities.providers.find((entry) => entry.name === controller.currentConfig.provider);
  if (provider?.credentialConfigured) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-warn-wash px-2.5 py-2 text-[11.5px] leading-5">
      <PlugZap size={14} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1">还没有填写 {controller.currentConfig.provider} 的 API Key。</span>
      <Button variant="secondary" size="sm" onClick={() => controller.navigate("/capabilities")}>连接模型</Button>
    </div>
  );
}

function OutputFormatSelector({ controller }: { controller: StartTranslateController }) {
  const config = controller.currentConfig;
  return (
    <div>
      <p className="mb-1 text-[12.5px] text-[var(--color-text-muted)]">导出格式</p>
      <div role="group" aria-label="导出格式" className="grid grid-cols-2 gap-1.5">
        {OUTPUT_FORMAT_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={config.outputFormat === option}
            onClick={() => controller.applyConfigPatch({ outputFormat: option })}
            className={`${CHIP_BASE} justify-center ${config.outputFormat === option ? CHIP_ON : CHIP_OFF}`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function AdvancedSettings({ controller }: { controller: StartTranslateController }) {
  const config = controller.currentConfig;
  const { glossaryOptions, styleGuideOptions } = useWorkspace();
  return (
    <details data-testid="advanced-translation-settings" className="group border-t border-line pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-3 text-[12.5px] [&::-webkit-details-marker]:hidden">
        <span className="font-medium">高级设置</span>
        <span className="ml-auto text-[11.5px] text-[var(--color-text-muted)]">导出格式、术语表、翻译风格</span>
        <ChevronRight size={14} className="transition group-open:rotate-90" />
      </summary>
      <div className="mt-3 space-y-3 border-t border-line pt-3">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Select
            label="翻译风格"
            options={optionsWithCurrent(styleGuideOptions, config.styleGuide)}
            value={config.styleGuide}
            onChange={(event) => controller.applyConfigPatch({ styleGuide: event.target.value })}
          />
          <Select
            label="术语表"
            options={optionsWithCurrent(glossaryOptions, config.glossary)}
            value={config.glossary}
            onChange={(event) => controller.applyConfigPatch({ glossary: event.target.value })}
          />
        </div>
        {config.provider === "OpenAI Compatible" ? (
          <div className="grid gap-2.5 sm:grid-cols-2">
            <Input label="自定义模型 ID" value={controller.customModel} onChange={(event) => controller.setCustomModel(event.target.value)} />
            <Input
              label="自定义 Base URL"
              value={controller.customBaseUrl}
              onChange={(event) => controller.setCustomBaseUrl(event.target.value)}
              placeholder="https://provider.example/v1"
            />
          </div>
        ) : null}
        <OutputFormatSelector controller={controller} />
      </div>
    </details>
  );
}

function TranslationSettings({ controller }: { controller: StartTranslateController }) {
  const config = controller.currentConfig;
  const modelOptions = useModelOptionsFor(config.provider);
  const providerUnsupported = !PROVIDER_OPTIONS.includes(config.provider);
  return (
    <Card title="检查后开始" description="只需确认语言和模型，其余步骤会自动完成。" className="min-w-0">
      <div className="space-y-4">
        <ConnectionPrerequisite controller={controller} />
        <Select
          label="源语言"
          options={optionsWithCurrent(SOURCE_LANGUAGE_OPTIONS, config.sourceLanguage)}
          value={config.sourceLanguage}
          onChange={(event) => controller.applyConfigPatch({ sourceLanguage: event.target.value })}
        />
        <TargetLanguageSelector controller={controller} />
        <div className="grid gap-2.5 sm:grid-cols-2">
          <Select
            label="翻译服务"
            options={optionsWithCurrent(PROVIDER_OPTIONS, config.provider)}
            value={config.provider}
            onChange={(event) => controller.applyConfigPatch({ provider: event.target.value })}
          />
          <Select
            label="模型"
            options={optionsWithCurrent(modelOptions, config.model)}
            value={config.model}
            onChange={(event) => controller.applyConfigPatch({ model: event.target.value })}
          />
        </div>
        {providerUnsupported ? (
          <p role="alert" className="text-[11.5px] leading-5 text-stop">
            当前选择的「{config.provider}」不能用于翻译，请换成列表里的服务商。
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y border-line py-3 text-[11.5px] text-[var(--color-text-muted)]">
          <strong className="text-[var(--color-text-main)]">自动流程</strong>
          <span>提取声音</span><span>—</span><span>生成字幕</span><span>—</span><span>翻译</span><span>—</span><span>字幕检查</span>
          <span className="basis-full">系统会按文件类型跳过不需要的步骤。</span>
        </div>
        <AdvancedSettings controller={controller} />
      </div>
    </Card>
  );
}

function StartFailureNotice({ controller }: { controller: StartTranslateController }) {
  if (!controller.translationStartError) return null;
  return (
    <div role="alert" className="flex min-w-0 items-center gap-2 rounded-[6px] border border-stop bg-stop-wash px-2.5 py-1">
      <AlertTriangle size={14} className="shrink-0 text-stop" />
      <span className="line-clamp-2 max-w-[34ch] text-[11.5px]" title={controller.translationStartError}>
        {controller.translationStartError}
      </span>
      <Button variant="ghost" size="sm" title="关闭这条提示" onClick={controller.dismissStartError}>关闭</Button>
    </div>
  );
}

function PageActions({ controller }: { controller: StartTranslateController }) {
  const project = controller.draftProject;
  const block = controller.startBlock;
  const workflow = controller.automaticWorkflow;
  const followsRoute = Boolean(block?.actionRoute);
  const running = workflow?.status === "running";
  const waitingForUser = workflow?.status === "blocked" && Boolean(workflow.resolution);
  const retryingExternalBlock = workflow?.status === "blocked" && !workflow.resolution;
  const startLabel = running
    ? "正在自动处理…"
    : retryingExternalBlock
      ? "重新检查并继续"
    : waitingForUser
      ? "等待你的确认"
      : block?.actionLabel
        ?? (project && !project.noSourceMedia && controller.draftSegments.length === 0
          ? "生成字幕并翻译"
          : "开始翻译");
  return (
    <BottomActionBar>
      <Button
        variant="secondary"
        icon={<Trash2 size={14} />}
        disabled={!project || running}
        title={project ? "把本次导入移入回收站，之后可以恢复" : "当前没有可取消的导入"}
        onClick={() => {
          if (!project) return;
          void controller.trashProject(project.id).then((result) => {
            if (result.ok) controller.navigate("/");
          });
        }}
      >
        取消本次导入
      </Button>
      <div className="flex min-w-0 items-center gap-2">
        <StartFailureNotice controller={controller} />
        <span className="hidden max-w-[32ch] text-right text-[11.5px] text-[var(--color-text-muted)] lg:block">
          {block ? block.reason : `将翻译为 ${controller.currentConfig.targetLanguages.join("、")}`}
        </span>
        <Button
          variant="primary"
          icon={<Play size={14} />}
          disabled={!project || running || waitingForUser || Boolean(block && !followsRoute)}
          title={workflow?.message ?? block?.reason ?? "自动准备字幕并开始翻译"}
          onClick={() => followsRoute ? controller.navigate(block!.actionRoute!) : void controller.start()}
        >
          {startLabel}
        </Button>
      </div>
    </BottomActionBar>
  );
}

export function StartTranslateView({ controller }: { controller: StartTranslateController }) {
  const project = controller.draftProject;
  return (
    <>
      <PageHeader
        title="开始翻译"
        description={project
          ? "文件已经准备好，只需确认语言和模型。"
          : "导入视频、音频或字幕，系统会自动完成可以省略的步骤。"}
      />
      {controller.requestedProjectMissing ? (
        <MissingProject controller={controller} />
      ) : project ? (
        <>
          <AutomaticWorkflowBanner
            state={controller.automaticWorkflow}
            recognitionProgress={controller.recognitionProgress}
            onAction={() => controller.automaticWorkflow?.actionRoute
              && controller.navigate(controller.automaticWorkflow.actionRoute)}
            onResolve={controller.resolveAutomaticBlock}
            onCancel={() => void controller.cancelAutomaticWorkflow()}
            onRetry={() => void controller.start()}
          />
          <div className="grid min-h-0 items-start gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
            <PreparedFile controller={controller} />
            <TranslationSettings controller={controller} />
            <div className="xl:col-span-2"><PendingImportCards controller={controller} /></div>
          </div>
        </>
      ) : (
        <div className="mx-auto max-w-5xl space-y-4">
          <ImportDropzone controller={controller} />
          <PendingImportCards controller={controller} />
          {controller.showFirstRunReadiness
            ? <FirstRunReadiness controller={controller} />
            : <ModelStatusRow controller={controller} />}
          <RecentProjects controller={controller} />
        </div>
      )}
      {project ? <PageActions controller={controller} /> : null}
    </>
  );
}
