import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  Palette,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import Badge from "../components/ui/Badge";
import BottomActionBar from "../components/ui/BottomActionBar";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import Input from "../components/ui/Input";
import StatCard from "../components/ui/StatCard";
import Tabs from "../components/ui/Tabs";
import Toggle from "../components/ui/Toggle";
import GlossaryEditor from "../components/feature/resource-library/GlossaryEditor";
import StyleGuideEditor from "../components/feature/resource-library/StyleGuideEditor";
import {
  BILINGUAL_LABELS,
  POSITION_LABELS,
  RESOURCE_SELECT,
  SubtitleStyleEditor,
  SubtitleStylePreview,
} from "../components/feature/resource-library/SubtitleStyleEditor";
import {
  describePayloadProblem,
  formatPayload,
  parsePayload,
  type PayloadState,
} from "../components/feature/resource-library/payload";
import type {
  AnyGlobalResource,
  ExportContent,
  ExportPresetPayload,
  GlossaryPayload,
  ResourceKind,
  ResourceLibrary,
  ResourceWriteInput,
  StyleGuidePayload,
  SubtitleExportFormat,
  SubtitleStylePayload,
} from "../domain/resource-library";
import { createDefaultSubtitleStyle } from "../domain/resource-library";
import PageHeader from "../layout/PageHeader";
import { useWorkspace } from "../state/WorkspaceContext";

const TAB_KIND = {
  术语库: "glossary",
  风格指南: "style_guide",
  字幕样式: "subtitle_style",
  导出预设: "export_preset",
} as const satisfies Record<string, ResourceKind>;

const KIND_LABEL: Record<ResourceKind, string> = {
  glossary: "术语表",
  style_guide: "风格指南",
  subtitle_style: "字幕样式",
  export_preset: "导出预设",
};

/** 空态引导语：说清楚这类资源是干什么用的，而不是只说"还没有" */
const KIND_INTRO: Record<ResourceKind, string> = {
  glossary: "固定某些词的译法。比如把人名、产品名、专有名词锁死，翻译时就不会一会儿一个说法。",
  style_guide: "告诉模型用什么口吻翻译。比如纪录片旁白、口语对话、正式书面，语气会明显不同。",
  subtitle_style: "字幕的外观：字体、字号、颜色、描边、位置。导出 ASS 时生效。",
  export_preset: "把常用的导出组合存下来，下次一键套用，不用每次重新选格式和排版。",
};

/** 每类资源在这里是干什么用的，用一句用户能懂的话说明 */
const KIND_HINT: Record<ResourceKind, string> = {
  glossary: "固定译法：翻译时会按这里写的译文对齐",
  style_guide: "语气与风格要求：会写进每次翻译的提示",
  subtitle_style: "字体、描边和双语排布，用于 ASS 输出",
  export_preset: "导出哪些文件、怎么命名、放到哪个目录",
};

const CONTENT_LABELS: Record<string, string> = {
  source: "原文",
  target: "译文",
  bilingual: "双语",
};

type MessageTone = "info" | "error";
interface PageMessage {
  text: string;
  tone: MessageTone;
}
const EMPTY_MESSAGE: PageMessage = { text: "", tone: "info" };

function idFor(kind: ResourceKind) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${kind.replace(/_/g, "-")}-${suffix}`;
}

function defaultPayload(kind: ResourceKind) {
  if (kind === "glossary") return {
    languagePairs: [{ sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [] }],
  };
  if (kind === "style_guide") return {
    targetLanguageCode: "zh-CN",
    tags: [],
    scenes: [],
    rules: [{ id: "rule-1", title: "简洁", instruction: "保持译文自然、简洁。", enabled: true }],
  };
  if (kind === "export_preset") return {
    outputs: [{ content: "target", format: "srt" }],
    burnVideo: false,
    fileNameTemplate: "{project}-{language}",
    destination: { kind: "project_exports" },
  };
  return createDefaultSubtitleStyle();
}

function allResources(library: ResourceLibrary): AnyGlobalResource[] {
  return [
    ...library.glossaries,
    ...library.styleGuides,
    ...library.subtitleStyles,
    ...library.exportPresets,
  ];
}

function toDraft(resource: AnyGlobalResource): ResourceWriteInput {
  return {
    id: resource.id,
    kind: resource.kind,
    name: resource.name,
    description: resource.description,
    payload: structuredClone(resource.payload),
  } as ResourceWriteInput;
}

function downloadResource(resource: AnyGlobalResource) {
  const blob = new Blob([JSON.stringify(resource, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${resource.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function matchQuery(resources: AnyGlobalResource[], query: string) {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return resources;
  return resources.filter((resource) => (
    `${resource.name} ${resource.description}`.toLowerCase().includes(keyword)
  ));
}

function isDraftDirty(
  draft: ResourceWriteInput | null,
  selected: AnyGlobalResource | null,
  payloadText: string,
) {
  return Boolean(draft && selected && draft.id === selected.id && (
    draft.name !== selected.name
    || draft.description !== selected.description
    || payloadText !== formatPayload(selected.payload)
  ));
}

function newDraft(kind: ResourceKind): ResourceWriteInput {
  return {
    id: idFor(kind), kind, name: `新建${KIND_LABEL[kind]}`, description: "", payload: defaultPayload(kind),
  } as ResourceWriteInput;
}

function useResourceSelection(library: ResourceLibrary) {
  const [tab, setTab] = useState<keyof typeof TAB_KIND>("术语库");
  const [selectedId, setSelectedId] = useState("");
  const [draftMode, setDraftMode] = useState<"existing" | "new">("existing");
  const [draft, setDraft] = useState<ResourceWriteInput | null>(null);
  const [payloadText, setPayloadText] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<PageMessage>(EMPTY_MESSAGE);
  const importRef = useRef<HTMLInputElement>(null);
  const loadedKey = useRef("");
  const kind = TAB_KIND[tab];

  const kindResources = useMemo(
    () => allResources(library).filter((resource) => resource.kind === kind),
    [kind, library],
  );
  // 搜索只过滤列表，不参与选中项的计算：旧版 selected 依赖过滤结果，
  // 搜一个词就会把正在编辑的草稿换掉。
  const resources = useMemo(() => matchQuery(kindResources, query), [kindResources, query]);

  // 未保存的新建草稿不回退到列表首项。旧版这里是 `?? resources[0]`，
  // 于是「新建」刚建好的草稿会被下面的 effect 立刻用列表第一项覆盖。
  const selected = draftMode === "new"
    ? null
    : kindResources.find((resource) => resource.id === selectedId) ?? kindResources[0] ?? null;

  const dirty = draftMode === "new"
    ? Boolean(draft)
    : isDraftDirty(draft, selected, payloadText);

  const loadResource = (resource: AnyGlobalResource) => {
    loadedKey.current = `${resource.kind}:${resource.id}:${resource.revision}`;
    setDraftMode("existing");
    setSelectedId(resource.id);
    setDraft(toDraft(resource));
    setPayloadText(formatPayload(resource.payload));
  };

  // 只在「目标资源换了」时同步草稿：新建草稿和未保存的修改都不会被覆盖。
  useEffect(() => {
    if (draftMode === "new") return;
    if (!selected) {
      loadedKey.current = "";
      setSelectedId("");
      setDraft(null);
      setPayloadText("");
      return;
    }
    if (loadedKey.current === `${kind}:${selected.id}:${selected.revision}`) return;
    if (dirty && draft?.id === selected.id) return;
    loadResource(selected);
  });

  const notify = (text: string) => setMessage({ text, tone: "info" });
  const fail = (text: string) => setMessage({ text, tone: "error" });

  const confirmDiscard = () => {
    if (!dirty) return true;
    const name = draft?.name || "当前资源";
    return window.confirm(draftMode === "new"
      ? `新建的「${name}」还没有保存，离开后会丢失。确定继续吗？`
      : `「${name}」有未保存的修改，切换后会丢失。确定继续吗？`);
  };

  const selectResource = (resource: AnyGlobalResource) => {
    if (resource.id !== selected?.id && !confirmDiscard()) return;
    loadResource(resource);
    setMessage(EMPTY_MESSAGE);
  };

  const createResource = () => {
    if (!confirmDiscard()) return;
    const resource = newDraft(kind);
    loadedKey.current = "";
    setDraftMode("new");
    setSelectedId(resource.id);
    setDraft(resource);
    setPayloadText(formatPayload(resource.payload));
    notify("新资源还没保存，填好后点右下角「保存」。");
  };

  const changeTab = (value: string) => {
    if (!confirmDiscard()) return;
    loadedKey.current = "";
    setTab(value as keyof typeof TAB_KIND);
    setDraftMode("existing");
    setSelectedId("");
    setDraft(null);
    setPayloadText("");
    setQuery("");
    setMessage(EMPTY_MESSAGE);
  };

  const activeDraft = draft?.kind === kind ? draft : null;
  const payloadState: PayloadState = useMemo(
    () => parsePayload(activeDraft ? payloadText : ""),
    [activeDraft, payloadText],
  );

  return {
    tab, kind, selected, resources, kindResources, dirty,
    selectedId: draftMode === "new" ? "" : selected?.id ?? "",
    isNew: draftMode === "new",
    draft: activeDraft,
    payloadText: activeDraft ? payloadText : "",
    payloadState, query, message, importRef,
    setDraft, setPayloadText, setQuery, notify, fail,
    loadResource, selectResource, createResource, changeTab,
  };
}

type Selection = ReturnType<typeof useResourceSelection>;

function useResourceActions(selection: Selection) {
  const {
    projects,
    saveLibraryResource,
    deleteLibraryResource,
    refreshProjectResourceSnapshot,
  } = useWorkspace();
  const [snapshotProjectId, setSnapshotProjectId] = useState("");
  const [pendingImport, setPendingImport] = useState<
    { resource: ResourceWriteInput; existing: AnyGlobalResource } | null
  >(null);

  const save = async () => {
    const draft = selection.draft;
    if (!draft) return;
    if (!selection.payloadState.ok) return selection.fail(selection.payloadState.message);
    const problem = describePayloadProblem(draft.kind, selection.payloadState.value);
    if (problem) return selection.fail(problem);
    const resource = { ...draft, payload: selection.payloadState.value } as ResourceWriteInput;
    const current = selection.selected?.id === resource.id ? selection.selected : null;
    const result = await saveLibraryResource(resource, current?.revision);
    if (!result.ok) return selection.fail(result.message);
    selection.loadResource(result.resource);
    selection.notify(`已保存，当前是第 ${result.resource.revision} 版`);
  };

  const remove = async () => {
    const resource = selection.selected;
    if (!resource) return;
    if (!window.confirm(`确定删除「${resource.name}」吗？删除不可撤销，已经在用它的项目不受影响。`)) return;
    const result = await deleteLibraryResource(resource.id, resource.revision);
    if (result.ok) selection.notify("已删除；已经在用它的项目不受影响");
    else selection.fail(result.message ?? "删除失败");
  };

  const commitImport = async (resource: ResourceWriteInput, expectedRevision?: number) => {
    const result = await saveLibraryResource(resource, expectedRevision);
    if (!result.ok) return selection.fail(result.message);
    setPendingImport(null);
    selection.loadResource(result.resource);
    selection.notify(`已导入「${result.resource.name}」`);
  };

  // 导出的 JSON 带着原来的 id。旧版直接原样保存且不带 revision，
  // 后端一律判成冲突，于是「导出 → 导入」这条最自然的路径 100% 失败。
  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = parsePayload(await file.text());
      if (!parsed.ok) throw new Error(`这个文件不是有效的 JSON：${parsed.message}`);
      const raw = asObject(parsed.value);
      const fileKind = raw?.kind as ResourceKind | undefined;
      if (fileKind !== selection.kind) {
        const label = fileKind && KIND_LABEL[fileKind] ? `「${KIND_LABEL[fileKind]}」` : "无法识别的类型";
        throw new Error(`这个文件是${label}，当前页只能导入${KIND_LABEL[selection.kind]}`);
      }
      const resource = {
        id: typeof raw?.id === "string" && raw.id ? raw.id : idFor(selection.kind),
        kind: fileKind,
        name: typeof raw?.name === "string" && raw.name ? raw.name : `导入的${KIND_LABEL[selection.kind]}`,
        description: typeof raw?.description === "string" ? raw.description : "",
        payload: raw?.payload,
      } as ResourceWriteInput;
      const existing = selection.kindResources.find((item) => item.id === resource.id) ?? null;
      if (existing) {
        setPendingImport({ resource, existing });
        selection.notify(`库里已经有同一个 ID 的「${existing.name}」，选择覆盖还是另存副本。`);
        return;
      }
      await commitImport(resource);
    } catch (error) {
      selection.fail(error instanceof Error ? error.message : "导入失败");
    } finally {
      if (selection.importRef.current) selection.importRef.current.value = "";
    }
  };

  const refreshSnapshot = async () => {
    if (!selection.selected || !snapshotProjectId) return;
    const project = projects.find((item) => item.id === snapshotProjectId);
    const result = await refreshProjectResourceSnapshot(snapshotProjectId, selection.selected.id);
    if (result.ok) {
      selection.notify(`已把第 ${selection.selected.revision} 版复制给项目「${project?.title ?? snapshotProjectId}」`);
      return;
    }
    selection.fail(result.message ?? "刷新失败");
  };

  return {
    projects, snapshotProjectId, setSnapshotProjectId, save, remove, importJson, refreshSnapshot,
    pendingImport,
    overwriteImport: () => {
      if (pendingImport) void commitImport(pendingImport.resource, pendingImport.existing.revision);
    },
    importAsCopy: () => {
      if (!pendingImport) return;
      void commitImport({
        ...pendingImport.resource,
        id: idFor(selection.kind),
        name: `${pendingImport.resource.name}（副本）`,
      } as ResourceWriteInput);
    },
    cancelImport: () => {
      setPendingImport(null);
      selection.notify("");
    },
    exportJson: () => {
      if (!selection.selected) return;
      downloadResource(selection.selected);
      selection.notify("已导出 JSON 文件");
    },
  };
}

function useResourceWorkbench() {
  const { library } = useWorkspace();
  const selection = useResourceSelection(library);
  return { ...selection, ...useResourceActions(selection) };
}

type Workbench = ReturnType<typeof useResourceWorkbench>;

function isSubtitleStyle(value: unknown): value is SubtitleStylePayload {
  const payload = asObject(value);
  return Boolean(payload && asObject(payload.primary) && asObject(payload.secondary) && asObject(payload.preview));
}

function isExportPreset(value: unknown): value is ExportPresetPayload {
  const payload = asObject(value);
  return Boolean(payload && Array.isArray(payload.outputs) && asObject(payload.destination));
}

function exportFileNameSample(payload: ExportPresetPayload) {
  const output = payload.outputs[0] ?? { content: "target" as const, format: "srt" as const };
  const stem = payload.fileNameTemplate
    .replace(/\{project\}/g, "示例项目")
    .replace(/\{language\}/g, "zh-CN")
    .replace(/\{content\}/g, output.content);
  return `${stem || "示例项目"}.${output.format}`;
}

function ExportPresetEditor({
  payload,
  onChange,
}: {
  payload: ExportPresetPayload;
  onChange: (next: ExportPresetPayload) => void;
}) {
  const patchOutput = (index: number, patch: Partial<ExportPresetPayload["outputs"][number]>) => {
    onChange({
      ...payload,
      outputs: payload.outputs.map((output, current) => current === index ? { ...output, ...patch } : output),
    });
  };
  return (
    <div className="space-y-2.5">
      <div className="space-y-1.5">
        <p className="text-[12.5px] text-[var(--color-text-muted)]">输出文件</p>
        {payload.outputs.map((output, index) => (
          <div key={`${output.content}-${output.format}-${index}`} className="grid gap-2 rounded-[6px] border border-line bg-card-soft p-2 sm:grid-cols-[1fr_1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-[var(--color-text-muted)]">内容</span>
              <select value={output.content} className={RESOURCE_SELECT} onChange={(event) => patchOutput(index, { content: event.target.value as ExportContent })}>
                {(Object.entries(CONTENT_LABELS) as Array<[ExportContent, string]>).map(([content, text]) => <option key={content} value={content}>{text}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] text-[var(--color-text-muted)]">格式</span>
              <select value={output.format} className={RESOURCE_SELECT} onChange={(event) => patchOutput(index, { format: event.target.value as SubtitleExportFormat })}>
                {(["srt", "vtt", "ass"] as SubtitleExportFormat[]).map((format) => <option key={format} value={format}>{format.toUpperCase()}</option>)}
              </select>
            </label>
            <Button
              className="self-end"
              size="sm"
              variant="ghost"
              icon={<Trash2 size={14} />}
              disabled={payload.outputs.length === 1}
              aria-label={`删除第 ${index + 1} 个输出`}
              title={payload.outputs.length === 1 ? "至少保留一个输出文件" : "删除这个输出文件"}
              onClick={() => onChange({ ...payload, outputs: payload.outputs.filter((_, current) => current !== index) })}
            />
          </div>
        ))}
        <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={() => onChange({ ...payload, outputs: [...payload.outputs, { content: "target", format: "srt" }] })}>
          添加输出文件
        </Button>
      </div>
      <Input
        label="文件名模板"
        value={payload.fileNameTemplate}
        hint="可用 {project}、{language}、{content}"
        onChange={(event) => onChange({ ...payload, fileNameTemplate: event.target.value })}
      />
      <div className="rounded-[6px] border border-line bg-card-soft px-3 py-2 text-[12.5px]">
        <span className="text-[var(--color-text-muted)]">文件名示例：</span>
        <strong className="break-any font-medium text-[var(--color-text-main)]">{exportFileNameSample(payload)}</strong>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">输出目录</span>
          <select
            value={payload.destination.kind}
            className={RESOURCE_SELECT}
            onChange={(event) => onChange({
              ...payload,
              destination: event.target.value === "custom_directory"
                ? { kind: "custom_directory", directory: "" }
                : { kind: "project_exports" },
            })}
          >
            <option value="project_exports">项目 exports 文件夹</option>
            <option value="custom_directory">自定义目录</option>
          </select>
        </label>
        {payload.destination.kind === "custom_directory" ? (
          <Input label="自定义目录" value={payload.destination.directory} placeholder="D:\\字幕导出" onChange={(event) => onChange({ ...payload, destination: { kind: "custom_directory", directory: event.target.value } })} />
        ) : null}
      </div>
      <div className="rounded-[6px] border border-line bg-card-soft p-1.5">
        <Toggle checked={payload.burnVideo} label="同时烧录视频" onChange={(burnVideo) => onChange({ ...payload, burnVideo })} />
      </div>
    </div>
  );
}

function ResourceToolbar({ workbench }: { workbench: Workbench }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Tabs items={Object.keys(TAB_KIND)} value={workbench.tab} onChange={workbench.changeTab} />
      <span className="text-[11.5px] text-[var(--color-text-muted)]">{KIND_HINT[workbench.kind]}</span>
      <div className="ml-auto flex items-center gap-2">
        <div className="w-[200px]">
          <Input
            value={workbench.query}
            onChange={(event) => workbench.setQuery(event.target.value)}
            placeholder={`搜索${KIND_LABEL[workbench.kind]}…`}
          />
        </div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={workbench.createResource}>
          新建{KIND_LABEL[workbench.kind]}
        </Button>
      </div>
    </div>
  );
}

function ImportConflictNotice({ workbench }: { workbench: Workbench }) {
  const pending = workbench.pendingImport;
  if (!pending) return null;
  return (
    <div
      role="alert"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-warn-wash px-3 py-2 text-[12.5px] text-[var(--color-text-main)]"
    >
      <TriangleAlert size={14} className="shrink-0 text-warn" />
      <span className="min-w-0">
        库里已经有同一个 ID 的「{pending.existing.name}」（第 {pending.existing.revision} 版）。
        覆盖会用文件内容替换它；另存副本会保留两份。
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button variant="primary" icon={<Copy size={14} />} onClick={workbench.importAsCopy}>另存为副本</Button>
        <Button variant="danger" onClick={workbench.overwriteImport} title="用文件内容替换现有资源，无法撤销">覆盖现有资源</Button>
        <Button variant="ghost" onClick={workbench.cancelImport}>取消导入</Button>
      </div>
    </div>
  );
}

function ResourceListPanel({ workbench }: { workbench: Workbench }) {
  const hiddenSelected = Boolean(
    workbench.selected && !workbench.resources.some((resource) => resource.id === workbench.selected?.id),
  );
  return (
    <Card title={KIND_LABEL[workbench.kind]} description={`${workbench.resources.length} 个`}>
      <div className="space-y-1.5">
        {workbench.resources.map((resource) => (
          <button
            key={resource.id}
            type="button"
            onClick={() => workbench.selectResource(resource)}
            className={`block w-full rounded-[6px] border px-2.5 py-2 text-left transition ${
              resource.id === workbench.selectedId
                ? "border-gold bg-gold-wash"
                : "border-line bg-card-soft hover:border-line-strong"
            }`}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0 text-[13px] font-medium text-[var(--color-text-main)]">{resource.name}</span>
              <Badge tone={resource.id === workbench.selectedId ? "gold" : "gray"}>
                版本 {resource.revision}
              </Badge>
            </span>
            <span className="mt-0.5 block truncate text-[11.5px] text-[var(--color-text-muted)]">
              {resource.description || "还没有写说明"}
            </span>
          </button>
        ))}
        {workbench.resources.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={20} />}
            title={workbench.query ? "没有匹配的资源" : `还没有${KIND_LABEL[workbench.kind]}`}
            description={workbench.query
              ? "换个关键词，或者清空搜索框看全部。"
              : "新建一个，或者导入别人给你的 JSON 文件。"}
            action={workbench.query ? (
              <Button variant="secondary" onClick={() => workbench.setQuery("")}>清空搜索</Button>
            ) : (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<Plus size={14} />} onClick={workbench.createResource}>新建</Button>
                <Button
                  variant="secondary"
                  icon={<Upload size={14} />}
                  onClick={() => workbench.importRef.current?.click()}
                >
                  导入 JSON
                </Button>
              </div>
            )}
          />
        ) : null}
        {hiddenSelected ? (
          <p className="rounded-[6px] border border-dashed border-line px-2.5 py-2 text-[11.5px] text-[var(--color-text-muted)]">
            正在编辑的「{workbench.selected?.name}」不在当前搜索结果里，改动仍然保留着。
          </p>
        ) : null}
      </div>
    </Card>
  );
}

function StructuredEditor({ workbench }: { workbench: Workbench }) {
  const draft = workbench.draft;
  const state = workbench.payloadState;
  if (!draft || !state.ok || !asObject(state.value)) return null;
  const write = (next: unknown) => workbench.setPayloadText(formatPayload(next));
  if (draft.kind === "glossary") {
    return (
      <GlossaryEditor
        key={draft.id}
        payload={state.value as GlossaryPayload}
        onChange={write}
        projects={workbench.projects}
      />
    );
  }
  if (draft.kind === "style_guide") {
    return <StyleGuideEditor key={draft.id} payload={state.value as StyleGuidePayload} onChange={write} />;
  }
  if (draft.kind === "subtitle_style" && isSubtitleStyle(state.value)) {
    return <SubtitleStyleEditor key={draft.id} payload={state.value} onChange={write} />;
  }
  if (draft.kind === "export_preset" && isExportPreset(state.value)) {
    return <ExportPresetEditor key={draft.id} payload={state.value} onChange={write} />;
  }
  return null;
}

function PayloadJsonEditor({ workbench }: { workbench: Workbench }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">内容（JSON）</span>
      <textarea
        value={workbench.payloadText}
        onChange={(event) => workbench.setPayloadText(event.target.value)}
        spellCheck={false}
        rows={12}
        className="control-surface w-full rounded-[6px] border border-line-strong bg-card px-2.5 py-2 font-mono text-[12.5px] leading-5 text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold"
      />
    </label>
  );
}

function ResourceEditorPanel({ workbench }: { workbench: Workbench }) {
  const [jsonExpanded, setJsonExpanded] = useState(false);
  const draft = workbench.draft;
  const structured = Boolean(draft);
  const showJson = Boolean(draft) && (jsonExpanded || !workbench.payloadState.ok);
  return (
    <Card
      title={draft ? draft.name || "未命名资源" : `编辑${KIND_LABEL[workbench.kind]}`}
      description="改完点右下角「保存」才会生效；已经在用它的项目不会被改动。"
      actions={workbench.dirty ? <Badge tone="gold">未保存</Badge> : null}
    >
      {draft ? (
        <div className="space-y-2.5">
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              label="名称"
              value={draft.name}
              onChange={(event) => workbench.setDraft({ ...draft, name: event.target.value } as ResourceWriteInput)}
            />
            <Input label="资源 ID" value={draft.id} disabled title="项目按 ID 引用这份资源，创建后不能改" />
          </div>
          <Input
            label="说明"
            value={draft.description}
            placeholder="一句话写清楚它适合什么场景"
            onChange={(event) => workbench.setDraft({ ...draft, description: event.target.value } as ResourceWriteInput)}
          />
          <StructuredEditor workbench={workbench} />
          {structured ? (
            <Button
              variant="ghost"
              size="sm"
              icon={showJson ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              onClick={() => setJsonExpanded(!jsonExpanded)}
            >
              高级：直接编辑 JSON
            </Button>
          ) : null}
          {showJson ? <PayloadJsonEditor workbench={workbench} /> : null}
          {!workbench.payloadState.ok ? (
            <p role="alert" className="text-[12.5px] text-stop">{workbench.payloadState.message}</p>
          ) : null}
        </div>
      ) : (
        <EmptyState
          icon={<BookOpen size={20} />}
          title="还没有选择资源"
          description="从左边的列表里挑一个开始编辑，或者新建一个。"
          action={(
            <Button variant="primary" icon={<Plus size={14} />} onClick={workbench.createResource}>
              新建{KIND_LABEL[workbench.kind]}
            </Button>
          )}
        />
      )}
    </Card>
  );
}

function GlossarySummary({ payload }: { payload: GlossaryPayload }) {
  const pairs = Array.isArray(payload.languagePairs) ? payload.languagePairs : [];
  const entries = pairs.flatMap((pair) => (Array.isArray(pair.entries) ? pair.entries : []));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="语言对" value={`${pairs.length}`} />
        <StatCard label="启用的术语" value={`${entries.filter((entry) => entry.enabled).length} / ${entries.length}`} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {pairs.map((pair, index) => (
          <Badge key={`${pair.sourceLanguageCode}-${pair.targetLanguageCode}-${index}`} tone="gray">
            {pair.sourceLanguageCode} → {pair.targetLanguageCode}
          </Badge>
        ))}
      </div>
      <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        翻译时命中原文的词会按这里的译文对齐；关掉的条目会留在表里但不生效。
      </p>
    </div>
  );
}

function StyleGuideSummary({ payload }: { payload: StyleGuidePayload }) {
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <StatCard label="启用的要求" value={`${rules.filter((rule) => rule.enabled).length} / ${rules.length}`} />
        <StatCard label="目标语言" value={payload.targetLanguageCode || "未填"} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {scenes.map((scene) => <Badge key={scene} tone="gray">{scene}</Badge>)}
      </div>
      <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        启用的要求会按顺序写进每次翻译的提示，条数越多单次请求越长。
      </p>
    </div>
  );
}

function SubtitleStyleSummary({ payload }: { payload: SubtitleStylePayload }) {
  return (
    <div className="space-y-2">
      <SubtitleStylePreview payload={payload} />
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="gold">{BILINGUAL_LABELS[payload.bilingualLayout] ?? payload.bilingualLayout}</Badge>
        <Badge tone="gray">{POSITION_LABELS[payload.primary.position] ?? payload.primary.position}</Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11.5px] text-[var(--color-text-muted)]">
        <span className="truncate">主字幕 {payload.primary.fontFamily} / {payload.primary.fontSizePx}px</span>
        <span className="truncate">次字幕 {payload.secondary.fontFamily} / {payload.secondary.fontSizePx}px</span>
        <span>描边 {payload.primary.outlineWidthPx}px</span>
        <span>阴影 {payload.primary.shadowDepthPx}px</span>
      </div>
    </div>
  );
}

function ExportPresetSummary({ payload }: { payload: ExportPresetPayload }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[13px]">
        <FileJson size={16} className="shrink-0 text-[var(--color-text-muted)]" />
        <strong className="min-w-0 break-any font-medium">{payload.fileNameTemplate}</strong>
      </div>
      {payload.outputs.map((output, index) => (
        <div
          key={`${output.content}-${output.format}-${index}`}
          className="inspector-value flex items-center justify-between px-2.5 py-1.5 text-[12.5px]"
        >
          <span>{CONTENT_LABELS[output.content] ?? output.content}</span>
          <span className="tabular">{output.format.toUpperCase()}</span>
        </div>
      ))}
      <Badge tone={payload.burnVideo ? "gold" : "gray"}>
        {payload.burnVideo ? "同时烧录视频" : "不烧录视频"}
      </Badge>
      <p className="text-[11.5px] text-[var(--color-text-muted)]">
        输出目录：{payload.destination.kind === "project_exports" ? "项目内的 exports 文件夹" : payload.destination.directory}
      </p>
    </div>
  );
}

function ResourceSummaryPanel({ workbench }: { workbench: Workbench }) {
  const draft = workbench.draft;
  const value = workbench.payloadState.ok ? workbench.payloadState.value : null;
  const kind = draft?.kind ?? workbench.kind;
  const title = kind === "subtitle_style" ? "字幕效果预览" : kind === "export_preset" ? "导出内容" : "内容摘要";
  return (
    <Card title={title} description="项目会在创建或手动刷新时复制一份，之后改这里不影响已有项目。">
      {!draft ? (
        <p className="text-[12.5px] leading-6 text-[var(--color-text-muted)]">
          选中左边任意一项后，这里会显示它的内容概览。
        </p>
      ) : (
        <div className="space-y-2.5">
          {kind === "subtitle_style" && isSubtitleStyle(value) ? <SubtitleStyleSummary payload={value} /> : null}
          {kind === "export_preset" && isExportPreset(value) ? <ExportPresetSummary payload={value} /> : null}
          {kind === "glossary" && asObject(value) ? <GlossarySummary payload={value as GlossaryPayload} /> : null}
          {kind === "style_guide" && asObject(value) ? <StyleGuideSummary payload={value as StyleGuidePayload} /> : null}
          {!value ? (
            <p className="text-[12.5px] text-[var(--color-text-muted)]">内容还无法解析，修好 JSON 后这里会更新。</p>
          ) : null}
          <div className="flex items-center gap-2 border-t border-line pt-2 text-[11.5px] text-[var(--color-text-muted)]">
            <Palette size={14} className="shrink-0" />
            <span>
              {workbench.isNew
                ? "保存后会成为第 1 版。"
                : `当前第 ${workbench.selected?.revision ?? 1} 版。每次保存版本号加一；别人同时改过会先提示你，不会悄悄覆盖。`}
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

function SnapshotProjectPicker({ workbench }: { workbench: Workbench }) {
  return (
    <select
      value={workbench.snapshotProjectId}
      onChange={(event) => workbench.setSnapshotProjectId(event.target.value)}
      className="control-surface h-8 max-w-[200px] rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold"
      title="选择要把当前版本复制过去的项目"
    >
      <option value="">复制到项目…</option>
      {workbench.projects.filter((project) => !project.trashedAt).map((project) => (
        <option key={project.id} value={project.id}>{project.title}</option>
      ))}
    </select>
  );
}

function ResourceActionBar({ workbench }: { workbench: Workbench }) {
  const snapshotDisabled = !workbench.selected || !workbench.snapshotProjectId;
  const payloadBroken = !workbench.payloadState.ok;
  return (
    <BottomActionBar>
      <span
        role="status"
        title={workbench.message.text}
        className={`block max-w-[38ch] truncate text-[12.5px] ${
          workbench.message.tone === "error" ? "text-stop" : "text-[var(--color-text-muted)]"
        }`}
      >
        {workbench.message.text}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <SnapshotProjectPicker workbench={workbench} />
        <Button
          variant="secondary"
          icon={<RefreshCw size={14} />}
          onClick={() => void workbench.refreshSnapshot()}
          disabled={snapshotDisabled}
          title={snapshotDisabled
            ? "先选中一个已保存的资源和一个项目"
            : "把当前版本复制给该项目；之后这里再改不会自动同步过去"}
        >
          复制到项目
        </Button>
        <input
          ref={workbench.importRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => void workbench.importJson(event.target.files?.[0])}
        />
        <Button variant="secondary" icon={<Upload size={14} />} onClick={() => workbench.importRef.current?.click()}>
          导入 JSON
        </Button>
        <Button
          variant="secondary"
          icon={<Download size={14} />}
          onClick={workbench.exportJson}
          disabled={!workbench.selected}
          title={!workbench.selected ? "先选中一个已保存的资源" : "导出成 JSON 文件，可以给别人导入"}
        >
          导出 JSON
        </Button>
        <Button
          variant="danger"
          icon={<Trash2 size={14} />}
          onClick={() => void workbench.remove()}
          disabled={!workbench.selected}
          title={!workbench.selected ? "先选中一个已保存的资源" : "删除后不可撤销"}
        >
          删除
        </Button>
        <Button
          variant="primary"
          icon={<Save size={14} />}
          onClick={() => void workbench.save()}
          disabled={!workbench.draft || payloadBroken}
          title={!workbench.draft
            ? "先新建或选中一个资源"
            : payloadBroken ? "内容还有格式错误，修好后才能保存" : "保存并生成新版本"}
        >
          保存
        </Button>
      </div>
    </BottomActionBar>
  );
}

export default function TermsStylePage() {
  const workbench = useResourceWorkbench();
  return (
    <>
      <PageHeader
        title="资源库"
        description="术语表、风格指南、字幕样式和导出预设都在这里维护，项目按需要各取一份。"
      />
      <ResourceToolbar workbench={workbench} />
      <ImportConflictNotice workbench={workbench} />
      {/*
        完全空的时候三列会各自显示一个空状态，看起来像页面坏了。
        这种情况下只给一张整宽的引导卡；有内容再切回三列工作台。
      */}
      {workbench.resources.length === 0 && !workbench.query && !workbench.draft ? (
        <Card>
          <EmptyState
            icon={<BookOpen size={22} />}
            title={`还没有${KIND_LABEL[workbench.kind]}`}
            description={KIND_INTRO[workbench.kind]}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<Plus size={14} />} onClick={workbench.createResource}>
                  新建{KIND_LABEL[workbench.kind]}
                </Button>
                <Button
                  variant="secondary"
                  icon={<Upload size={14} />}
                  onClick={() => workbench.importRef.current?.click()}
                >
                  导入 JSON
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <div className="grid items-start gap-3 xl:grid-cols-[240px_minmax(0,1fr)_300px]">
          <ResourceListPanel workbench={workbench} />
          <ResourceEditorPanel workbench={workbench} />
          <ResourceSummaryPanel workbench={workbench} />
        </div>
      )}
      <ResourceActionBar workbench={workbench} />
    </>
  );
}
