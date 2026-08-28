import { useEffect, useMemo, useRef, useState } from "react";
import { parseGlossaryDelimited, serializeGlossaryDelimited, type GlossaryDelimitedFormat } from "../domain/glossary-delimited";
import { describePayloadProblem } from "../domain/resource-payload";
import type { AnyProjectResourceSnapshot } from "../domain/resource-library";
import {
  createDefaultSubtitleStyle,
  type AnyGlobalResource,
  type AssTextStyle,
  type ExportPresetPayload,
  type GlossaryEntry,
  type GlossaryPayload,
  type ResourceKind,
  type ResourceWriteInput,
  type StyleGuidePayload,
  type SubtitleStylePayload,
} from "../domain/resource-library";
import { localizeIpcErrorText } from "../i18n/errors";
import { desktopListProjectResourceSnapshots } from "../services/desktop-client";
import { useWorkspace } from "../state/WorkspaceContext";
import { useFrontend } from "./state";
import { Icon } from "./visuals";
import { formatUiDateTime } from "./format";

const kinds: Array<{ id: ResourceKind; label: string; code: string; intro: string; pitch: string }> = [
  { id: "glossary", label: "术语表", code: "TERM", intro: "固定专有名词、人名与产品名的译法。",
    pitch: "人名、产品名、专有名词每次都译得一样。建好挂到项目上，翻译时会随提示一起送给模型，不用逐条手改。" },
  { id: "style_guide", label: "风格指南", code: "TONE", intro: "把真实翻译规则、场景和示例写入模型提示。",
    pitch: "把「字幕要简洁」「保留英文缩写」这类要求写成规则，模型每次都照着来，省掉反复返工。" },
  { id: "subtitle_style", label: "字幕样式", code: "ASS", intro: "管理 ASS 字体、颜色、描边、位置与双语排布。",
    pitch: "字体、描边、位置、双语上下排布存成一套，导出 ASS 或烧录视频时直接套用。" },
  { id: "export_preset", label: "导出预设", code: "OUT", intro: "保存输出格式、命名和目的地组合。",
    pitch: "输出格式、文件命名和落盘目录存成一套，交付时一次选定，不用每回重填。" },
];

type Message = { text: string; error: boolean } | null;

function resourceId(kind: ResourceKind) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${kind.replace(/_/g, "-")}-${suffix}`;
}

function entryId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function defaultDraft(kind: ResourceKind): ResourceWriteInput {
  const base = { id: resourceId(kind), name: `新建${kinds.find((item) => item.id === kind)?.label ?? "资源"}`, description: "" };
  if (kind === "glossary") return { ...base, kind, payload: { languagePairs: [{ sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [] }] } };
  if (kind === "style_guide") return { ...base, kind, payload: { targetLanguageCode: "zh-CN", tags: [], scenes: [], rules: [] } };
  if (kind === "subtitle_style") return { ...base, kind, payload: createDefaultSubtitleStyle() };
  return { ...base, kind, payload: { outputs: [{ content: "target", format: "srt" }], burnVideo: false, fileNameTemplate: "{project}-{language}", destination: { kind: "project_exports" } } };
}

function draftFrom(resource: AnyGlobalResource): ResourceWriteInput {
  return { id: resource.id, kind: resource.kind, name: resource.name, description: resource.description, payload: structuredClone(resource.payload) } as ResourceWriteInput;
}

function resourcesOfKind(library: ReturnType<typeof useWorkspace>["library"], kind: ResourceKind): AnyGlobalResource[] {
  if (kind === "glossary") return library.glossaries;
  if (kind === "style_guide") return library.styleGuides;
  if (kind === "subtitle_style") return library.subtitleStyles;
  return library.exportPresets;
}

function downloadText(fileName: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function resourceSummary(resource: AnyGlobalResource) {
  if (resource.kind === "glossary") return `${resource.payload.languagePairs.reduce((count, pair) => count + pair.entries.length, 0)} 条术语`;
  if (resource.kind === "style_guide") return `${resource.payload.rules.length} 条规则`;
  if (resource.kind === "subtitle_style") return `${resource.payload.primary.fontFamily} · ${resource.payload.primary.fontSizePx}px`;
  return `${resource.payload.outputs.length} 个输出`;
}

function mergeGlossaryPayload(current: GlossaryPayload, incoming: GlossaryPayload) {
  const languagePairs = structuredClone(current.languagePairs);
  let added = 0;
  let skipped = 0;
  for (const importedPair of incoming.languagePairs) {
    let destination = languagePairs.find((pair) =>
      pair.sourceLanguageCode === importedPair.sourceLanguageCode &&
      pair.targetLanguageCode === importedPair.targetLanguageCode);
    if (!destination) {
      destination = { ...importedPair, entries: [] };
      languagePairs.push(destination);
    }
    const existing = new Set(destination.entries.map((entry) =>
      `${entry.source.trim().toLocaleLowerCase()}\u0000${entry.target.trim().toLocaleLowerCase()}`));
    for (const entry of importedPair.entries) {
      const key = `${entry.source.trim().toLocaleLowerCase()}\u0000${entry.target.trim().toLocaleLowerCase()}`;
      if (existing.has(key)) {
        skipped += 1;
      } else {
        destination.entries.push(entry);
        existing.add(key);
        added += 1;
      }
    }
  }
  return { payload: { languagePairs }, added, skipped };
}

export function LibraryPage() {
  const workspace = useWorkspace();
  const app = useFrontend();
  const [kind, setKind] = useState<ResourceKind>("glossary");
  const [draft, setDraft] = useState<ResourceWriteInput | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ draft: ResourceWriteInput; existing: AnyGlobalResource } | null>(null);
  const [snapshots, setSnapshots] = useState<Array<{ projectId: string; snapshot: AnyProjectResourceSnapshot }>>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const jsonInput = useRef<HTMLInputElement>(null);
  const glossaryInput = useRef<HTMLInputElement>(null);
  const resources = useMemo(() => resourcesOfKind(workspace.library, kind), [kind, workspace.library]);
  const visible = resources.filter((resource) => `${resource.name} ${resource.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = resources.find((resource) => resource.id === selectedId) ?? null;
  const dirty = Boolean(draft && (!selected || JSON.stringify(draft) !== JSON.stringify(draftFrom(selected))));

  useEffect(() => {
    if (draft?.kind === kind) return;
    const first = resources[0];
    setSelectedId(first?.id ?? "");
    setDraft(first ? draftFrom(first) : null);
  }, [kind, resources.length]);

  // "我能安全改它吗"要靠真实快照回答：项目一旦捕获，就是一份不可变副本，
  // 改全局资源不会回写它。所以这里把每个项目的快照都读出来，按 resourceId 归并。
  const activeProjects = workspace.projects.filter((project) => !project.trashedAt);
  const projectIdsKey = activeProjects.map((project) => project.id).join("|");
  useEffect(() => {
    let alive = true;
    setSnapshotsLoading(true);
    void Promise.all(activeProjects.map(async (project) => {
      const result = await desktopListProjectResourceSnapshots({ projectId: project.id });
      return result.ok ? result.data.map((snapshot) => ({ projectId: project.id, snapshot })) : [];
    })).then((groups) => {
      if (!alive) return;
      setSnapshots(groups.flat());
      setSnapshotsLoading(false);
    });
    return () => { alive = false; };
  }, [projectIdsKey]);

  const usageOf = (resource: AnyGlobalResource) => {
    const captured = snapshots.filter((entry) => entry.snapshot.source.kind === "global" && entry.snapshot.source.resourceId === resource.id);
    const boundField = resource.kind === "glossary" ? "glossary" : resource.kind === "style_guide" ? "styleGuide" : null;
    const bound = boundField
      ? activeProjects.filter((project) => project.config[boundField] === resource.name)
      : [];
    const projectIds = new Set([...captured.map((entry) => entry.projectId), ...bound.map((project) => project.id)]);
    const staleCaptures = captured.filter((entry) => entry.snapshot.source.kind === "global" && entry.snapshot.source.revision !== resource.revision);
    return { projectIds, captured, staleCaptures, supportsBinding: Boolean(boundField) };
  };

  const changeKind = (next: ResourceKind) => {
    const first = resourcesOfKind(workspace.library, next)[0];
    setKind(next);
    setSelectedId(first?.id ?? "");
    setDraft(first ? draftFrom(first) : null);
    setQuery("");
    setMessage(null);
    app.play("navigate");
  };

  const choose = (resource: AnyGlobalResource) => {
    setSelectedId(resource.id);
    setDraft(draftFrom(resource));
    setMessage(null);
    app.play("click");
  };

  const create = () => {
    setSelectedId("");
    setDraft(defaultDraft(kind));
    setMessage(null);
    app.play("click");
  };

  const save = async (value = draft, expectedRevision?: number) => {
    if (!value) return;
    const revision = expectedRevision ?? (selected?.id === value.id ? selected.revision : undefined);
    const problem = describePayloadProblem(value.kind, value.payload);
    if (problem) return setMessage({ text: problem, error: true });
    if (!value.name.trim()) return setMessage({ text: "资源名称不能为空。", error: true });
    setBusy(true);
    const result = await workspace.saveLibraryResource(value, revision);
    setBusy(false);
    if (!result.ok) return setMessage({ text: result.message, error: true });
    setKind(result.resource.kind);
    setSelectedId(result.resource.id);
    setDraft(draftFrom(result.resource));
    setMessage({ text: `已保存“${result.resource.name}”，当前为第 ${result.resource.revision} 版。`, error: false });
    app.play("success");
  };

  const remove = async () => {
    setDeleteConfirm(false);
    if (!selected) return;
    setBusy(true);
    const result = await workspace.deleteLibraryResource(selected.id, selected.revision);
    setBusy(false);
    if (!result.ok) return setMessage({ text: result.message ?? "资源删除失败", error: true });
    const remaining = resources.filter((resource) => resource.id !== selected.id);
    setSelectedId(remaining[0]?.id ?? "");
    setDraft(remaining[0] ? draftFrom(remaining[0]) : null);
    setMessage({ text: "资源已删除；项目中已经捕获的不可变快照不受影响。", error: false });
  };

  const exportJson = () => {
    if (!draft) return;
    const resource = selected && selected.id === draft.id ? { ...selected, ...draft } : draft;
    downloadText(`${draft.id}.json`, JSON.stringify(resource, null, 2), "application/json;charset=utf-8");
    setMessage({ text: "资源 JSON 已交给浏览器下载。", error: false });
  };

  const readJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("JSON 文件不能超过 2 MB。");
      const raw = JSON.parse(await file.text()) as Partial<AnyGlobalResource>;
      if (raw.kind !== kind) throw new Error(`这个文件不是当前的${kinds.find((item) => item.id === kind)?.label}类型。`);
      const imported = { id: typeof raw.id === "string" && raw.id ? raw.id : resourceId(kind), kind, name: typeof raw.name === "string" && raw.name ? raw.name : "导入的资源", description: typeof raw.description === "string" ? raw.description : "", payload: raw.payload } as ResourceWriteInput;
      const problem = describePayloadProblem(kind, imported.payload);
      if (problem) throw new Error(problem);
      const existing = resources.find((resource) => resource.id === imported.id);
      if (existing) setPendingImport({ draft: imported, existing });
      else await save(imported, undefined);
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "资源 JSON 无法读取。", error: true });
    } finally {
      if (jsonInput.current) jsonInput.current.value = "";
    }
  };

  const resolveImport = async (mode: "overwrite" | "copy") => {
    const value = pendingImport;
    setPendingImport(null);
    if (!value) return;
    const imported = mode === "copy" ? { ...value.draft, id: resourceId(value.draft.kind), name: `${value.draft.name} 副本` } as ResourceWriteInput : value.draft;
    await save(imported, mode === "overwrite" ? value.existing.revision : undefined);
  };

  const importGlossary = async (file: File | undefined) => {
    if (!file) return;
    try {
      const format: GlossaryDelimitedFormat = file.name.toLocaleLowerCase().endsWith(".tsv") ? "tsv" : "csv";
      const currentPayload = draft?.kind === "glossary" ? draft.payload : defaultDraft("glossary").payload as GlossaryPayload;
      const firstPair = currentPayload.languagePairs[0];
      const imported = parseGlossaryDelimited(await file.text(), { format, defaultSourceLanguageCode: firstPair?.sourceLanguageCode ?? "en-US", defaultTargetLanguageCode: firstPair?.targetLanguageCode ?? "zh-CN" });
      const merged = mergeGlossaryPayload(currentPayload, imported);
      const base = draft?.kind === "glossary" ? draft : defaultDraft("glossary");
      setDraft({ ...base, payload: merged.payload } as ResourceWriteInput);
      setMessage({ text: `已导入 ${merged.added} 条到草稿${merged.skipped ? `，跳过 ${merged.skipped} 条重复项` : ""}；保存后生效。`, error: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : "术语文件无法读取。", error: true });
    } finally {
      if (glossaryInput.current) glossaryInput.current.value = "";
    }
  };

  const exportGlossary = (format: GlossaryDelimitedFormat) => {
    if (draft?.kind !== "glossary") return;
    downloadText(`${draft.id}.${format}`, serializeGlossaryDelimited(draft.payload, format), format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8");
    setMessage({ text: `术语表 ${format.toUpperCase()} 已交给浏览器下载。`, error: false });
  };

  return (
    <div className="page-stage library-page secondary-page" data-fr03-view="resource-library">
      <header className="page-header"><div><h1>资源库</h1><p>全局资源由桌面后端版本化保存；项目使用时捕获不可变快照。</p></div><div className="page-actions"><input ref={jsonInput} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => void readJson(event.target.files?.[0])}/><button type="button" className="btn btn-secondary" onClick={() => jsonInput.current?.click()} disabled={busy || !workspace.isDesktop}><Icon name="upload"/>导入 JSON</button><button type="button" className="btn btn-primary" onClick={create} disabled={!workspace.isDesktop}>新建{kinds.find((item) => item.id === kind)?.label}</button></div></header>

      {!workspace.isDesktop ? <div className="runtime-alert" role="alert"><Icon name="warning"/><div><strong>浏览器预览为只读</strong><p>连接桌面后端后才能新建、导入、修改或删除版本化资源。</p></div></div> : null}
      {message ? <div className={`runtime-alert ${message.error ? "" : "is-success"}`} role={message.error ? "alert" : "status"}><Icon name={message.error ? "warning" : "check"}/><div><strong>{message.error ? "资源没有更新" : "资源库已响应"}</strong><p>{message.text}</p></div></div> : null}

      <div className="library-kind-tabs" role="tablist" aria-label="资源类型">{kinds.map((item) => <button type="button" role="tab" aria-selected={kind === item.id} className={kind === item.id ? "is-active" : ""} key={item.id} onClick={() => changeKind(item.id)}><span>{item.code}</span><strong>{item.label}</strong><em>{resourcesOfKind(workspace.library, item.id).length}</em></button>)}</div>

      {/* 分类为空时是一个整宽空态，不是并排两个：并排的两个空态只是把「什么都没有」说了两遍，
          而用户此刻需要知道的是这份资源能替他做什么、以及从哪儿开始。点了新建就有草稿，
          此时必须让位给编辑布局，否则新建按钮会指向一个不存在的编辑器。 */}
      {!resources.length && !draft ? (
        <section className="production-panel library-onboarding">
          <span className="library-onboarding-seal" aria-hidden="true">{kinds.find((item) => item.id === kind)?.code}</span>
          <div>
            <h2>还没有${kinds.find((item) => item.id === kind)?.label ?? "资源"}</h2>
            <p>{kinds.find((item) => item.id === kind)?.pitch}</p>
          </div>
          <div className="library-onboarding-actions">
            <button type="button" className="btn btn-primary" onClick={create} disabled={!workspace.isDesktop}>新建{kinds.find((item) => item.id === kind)?.label}</button>
            <button type="button" className="btn btn-secondary" onClick={() => jsonInput.current?.click()} disabled={busy || !workspace.isDesktop}><Icon name="upload"/>导入 JSON</button>
          </div>
        </section>
      ) : (
        <div className="library-layout">
        <aside className="production-panel library-rail"><header><div><span>{kinds.find((item) => item.id === kind)?.code} LIBRARY</span><strong>{kinds.find((item) => item.id === kind)?.label}</strong></div><button type="button" className="icon-btn" onClick={create} disabled={!workspace.isDesktop} aria-label="新建资源" title={workspace.isDesktop ? "新建资源" : "仅桌面应用可用"}>＋</button></header><label className="library-search"><span>筛选真实资源</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称或说明"/></label><div className="library-resource-list">{visible.map((resource) => <button type="button" key={resource.id} className={selectedId === resource.id ? "is-active" : ""} onClick={() => choose(resource)}><span><strong>{resource.name}</strong><small>{resource.description || resourceSummary(resource)}</small></span><em>v{resource.revision}</em></button>)}</div>{!visible.length ? <div className="production-empty panel-empty"><span className="empty-seal">00</span><div><strong>{query ? "没有匹配资源" : `还没有${kinds.find((item) => item.id === kind)?.label}`}</strong><p>{kinds.find((item) => item.id === kind)?.intro}</p></div></div> : null}</aside>

        <section className="production-panel resource-editor-sheet">{draft ? <><header><div><span>版本化资源</span><h2>{selected ? `编辑 v${selected.revision}` : "新资源草稿"}</h2></div><div><span className={`state-tag ${dirty ? "waiting" : "done"}`}>{dirty ? "尚未保存" : "已同步"}</span><button type="button" className="text-button" onClick={exportJson}>导出 JSON</button>{selected ? <button type="button" className="text-button danger-link" onClick={() => setDeleteConfirm(true)} disabled={!workspace.isDesktop}>删除</button> : null}</div></header><fieldset className="resource-editor-fieldset" disabled={!workspace.isDesktop}><div className="resource-meta-fields"><label><span>名称</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value } as ResourceWriteInput)}/></label><label><span>说明</span><input value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value } as ResourceWriteInput)} placeholder="这份资源的适用范围"/></label></div><ResourceEditor draft={draft} onChange={setDraft}/></fieldset><footer><span>{selected ? `后端修订号 ${selected.revision} · 更新于 ${formatUiDateTime(selected.updatedAt)}` : "保存后才成为全局资源，项目才能挂上它。"}</span><div>{dirty && selected ? <button type="button" className="btn btn-secondary" onClick={() => setDraft(draftFrom(selected))}>放弃修改</button> : null}<button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !dirty || !workspace.isDesktop}>{busy ? "保存中" : "保存并生成新版本"}</button></div></footer></> : <div className="resource-start-empty"><span aria-hidden="true">⌁</span><h2>选择或新建资源</h2><p>{kinds.find((item) => item.id === kind)?.intro}</p><button type="button" className="btn btn-primary" onClick={create} disabled={!workspace.isDesktop}>新建{kinds.find((item) => item.id === kind)?.label}</button></div>}</section>

          {/* 第三列回答"我能安全改它吗"：关联了几个项目、有没有被项目快照捕获。 */}
          <aside className="production-panel library-usage">
            <header><div><span>{kinds.find((item) => item.id === kind)?.label}</span><h2>使用情况</h2></div><span className="state-tag waiting">{snapshotsLoading ? "读取中" : `${activeProjects.length} 个项目`}</span></header>
            {selected ? (() => {
              const usage = usageOf(selected);
              return <>
                <dl>
                  <div><dt>关联项目</dt><dd>{usage.projectIds.size}</dd></div>
                  <div><dt>已捕获快照</dt><dd>{usage.captured.length}</dd></div>
                  <div><dt>当前版本</dt><dd>v{selected.revision}</dd></div>
                </dl>
                <p className="library-usage-verdict">
                  {usage.captured.length
                    ? `改这份资源不会改写已捕获的 ${usage.captured.length} 份项目快照；项目要用新版本得在项目设置里明确刷新。`
                    : "还没有项目捕获它的快照，现在改动不会影响任何已有项目。"}
                </p>
                {usage.staleCaptures.length ? <p className="library-usage-stale"><Icon name="warning"/>{usage.staleCaptures.length} 个项目捕获的是更早的版本。</p> : null}
                <div className="library-usage-projects">
                  {[...usage.projectIds].map((projectId) => {
                    const project = activeProjects.find((entry) => entry.id === projectId);
                    const capture = usage.captured.find((entry) => entry.projectId === projectId)?.snapshot.source;
                    return <article key={projectId}>
                      <strong>{project?.title ?? projectId}</strong>
                      <em>{capture && capture.kind === "global" ? `已捕获 v${capture.revision}` : "已在项目方案里选用，尚未捕获"}</em>
                    </article>;
                  })}
                  {!usage.projectIds.size ? <p className="library-usage-empty">{usage.supportsBinding ? "还没有项目用到它。" : "这类资源在项目里按需选用，暂无绑定记录。"}</p> : null}
                </div>
              </>;
            })() : <div className="production-empty panel-empty"><span className="empty-seal">—</span><div><strong>先选一份资源</strong><p>选中后这里显示它被哪些项目用到。</p></div></div>}
          </aside>
        </div>
      )}

      {kind === "glossary" && draft?.kind === "glossary" ? <section className="production-panel glossary-exchange"><div><span>CSV / TSV 交换</span><h2>CSV / TSV 交换</h2><p>导入只载入当前草稿，保存后才写入后端；公式前缀在导出时会被安全转义。</p></div><input ref={glossaryInput} className="visually-hidden" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" onChange={(event) => void importGlossary(event.target.files?.[0])}/><div><button type="button" className="btn btn-secondary" onClick={() => glossaryInput.current?.click()} disabled={!workspace.isDesktop}>导入 CSV / TSV</button><button type="button" className="btn btn-secondary" onClick={() => exportGlossary("csv")}>导出 CSV</button><button type="button" className="btn btn-secondary" onClick={() => exportGlossary("tsv")}>导出 TSV</button></div></section> : null}

      {deleteConfirm ? <div className="production-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDeleteConfirm(false); }}><section className="production-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-delete-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="resource-delete-title">删除“{selected?.name}”？</h2><p>全局资源会被永久删除；项目中已经捕获的不可变快照不会被改写或移除。</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setDeleteConfirm(false)}>取消</button><button type="button" className="btn btn-primary" onClick={() => void remove()}>确认删除</button></div></section></div> : null}
      {pendingImport ? <div className="production-dialog-backdrop" role="presentation"><section className="production-dialog resource-import-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-import-title"><span className="dialog-seal"><Icon name="warning"/></span><div><h2 id="resource-import-title">资源 ID 已存在</h2><p>“{pendingImport.existing.name}”当前为第 {pendingImport.existing.revision} 版。可明确覆盖生成新版本，或用新 ID 另存副本。</p></div><div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={() => setPendingImport(null)}>取消</button><button type="button" className="btn btn-secondary" onClick={() => void resolveImport("copy")}>另存副本</button><button type="button" className="btn btn-primary" onClick={() => void resolveImport("overwrite")}>覆盖并生成新版本</button></div></section></div> : null}
    </div>
  );
}

function ResourceEditor({ draft, onChange }: { draft: ResourceWriteInput; onChange: (value: ResourceWriteInput) => void }) {
  if (draft.kind === "glossary") return <GlossaryEditor payload={draft.payload} onChange={(payload) => onChange({ ...draft, payload })}/>;
  if (draft.kind === "style_guide") return <StyleGuideEditor payload={draft.payload} onChange={(payload) => onChange({ ...draft, payload })}/>;
  if (draft.kind === "subtitle_style") return <SubtitleStyleEditor payload={draft.payload} onChange={(payload) => onChange({ ...draft, payload })}/>;
  return <ExportPresetEditor payload={draft.payload} onChange={(payload) => onChange({ ...draft, payload })}/>;
}

function GlossaryEditor({ payload, onChange }: { payload: GlossaryPayload; onChange: (value: GlossaryPayload) => void }) {
  const patchPair = (index: number, patch: Partial<GlossaryPayload["languagePairs"][number]>) => onChange({ languagePairs: payload.languagePairs.map((pair, current) => current === index ? { ...pair, ...patch } : pair) });
  const patchEntry = (pairIndex: number, entryIndex: number, patch: Partial<GlossaryEntry>) => patchPair(pairIndex, { entries: payload.languagePairs[pairIndex].entries.map((entry, current) => current === entryIndex ? { ...entry, ...patch } : entry) });
  return <div className="structured-editor glossary-editor"><header><div><span>术语条目</span><h3>语言对与固定译法</h3></div><button type="button" className="btn btn-secondary" onClick={() => onChange({ languagePairs: [...payload.languagePairs, { sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [] }] })}>添加语言对</button></header>{payload.languagePairs.map((pair, pairIndex) => <section className="glossary-pair" key={`${pair.sourceLanguageCode}-${pair.targetLanguageCode}-${pairIndex}`}><header><label><span>源语言</span><input value={pair.sourceLanguageCode} onChange={(event) => patchPair(pairIndex, { sourceLanguageCode: event.target.value })}/></label><span className="pair-arrow">→</span><label><span>目标语言</span><input value={pair.targetLanguageCode} onChange={(event) => patchPair(pairIndex, { targetLanguageCode: event.target.value })}/></label><button type="button" className="text-button danger-link" onClick={() => onChange({ languagePairs: payload.languagePairs.filter((_, index) => index !== pairIndex) })} disabled={payload.languagePairs.length === 1}>删除语言对</button></header><div className="glossary-entry-head"><span>启用</span><span>原文</span><span>固定译文</span><span>词性 / 领域</span><span>标签 / 备注</span><span/></div>{pair.entries.map((entry, entryIndex) => <article key={entry.id}><input type="checkbox" checked={entry.enabled} onChange={(event) => patchEntry(pairIndex, entryIndex, { enabled: event.target.checked })} aria-label={`启用术语 ${entry.source}`}/><input value={entry.source} onChange={(event) => patchEntry(pairIndex, entryIndex, { source: event.target.value })} placeholder="原文术语"/><input value={entry.target} onChange={(event) => patchEntry(pairIndex, entryIndex, { target: event.target.value })} placeholder="固定译文"/><span><input value={entry.partOfSpeech ?? ""} onChange={(event) => patchEntry(pairIndex, entryIndex, { partOfSpeech: event.target.value || undefined })} placeholder="词性"/><input value={entry.domain ?? ""} onChange={(event) => patchEntry(pairIndex, entryIndex, { domain: event.target.value || undefined })} placeholder="领域"/></span><span><input value={entry.tags?.join(", ") ?? ""} onChange={(event) => patchEntry(pairIndex, entryIndex, { tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="标签，逗号分隔"/><input value={entry.note ?? ""} onChange={(event) => patchEntry(pairIndex, entryIndex, { note: event.target.value || undefined })} placeholder="备注"/></span><button type="button" className="text-button danger-link" onClick={() => patchPair(pairIndex, { entries: pair.entries.filter((_, index) => index !== entryIndex) })}>删除</button></article>)}<button type="button" className="add-structured-row" onClick={() => patchPair(pairIndex, { entries: [...pair.entries, { id: entryId("term"), source: "", target: "", enabled: true }] })}>＋ 添加术语</button></section>)}</div>;
}

function StyleGuideEditor({ payload, onChange }: { payload: StyleGuidePayload; onChange: (value: StyleGuidePayload) => void }) {
  return <div className="structured-editor style-guide-editor"><header><div><span>提示规则</span><h3>翻译语气与规则</h3></div><button type="button" className="btn btn-secondary" onClick={() => onChange({ ...payload, rules: [...payload.rules, { id: entryId("rule"), title: "", instruction: "", enabled: true }] })}>添加规则</button></header><div className="guide-meta-grid"><label><span>目标语言</span><input value={payload.targetLanguageCode} onChange={(event) => onChange({ ...payload, targetLanguageCode: event.target.value })}/></label><label><span>标签</span><input value={payload.tags.join(", ")} onChange={(event) => onChange({ ...payload, tags: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="纪录片, 正式"/></label><label><span>适用场景</span><input value={payload.scenes.join(", ")} onChange={(event) => onChange({ ...payload, scenes: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} placeholder="旁白, 对话"/></label></div><div className="guide-rule-list">{payload.rules.map((rule, index) => <article key={rule.id}><label className="rule-enabled"><input type="checkbox" checked={rule.enabled} onChange={(event) => onChange({ ...payload, rules: payload.rules.map((item, current) => current === index ? { ...item, enabled: event.target.checked } : item) })}/>启用</label><input value={rule.title} onChange={(event) => onChange({ ...payload, rules: payload.rules.map((item, current) => current === index ? { ...item, title: event.target.value } : item) })} placeholder="规则标题"/><textarea value={rule.instruction} onChange={(event) => onChange({ ...payload, rules: payload.rules.map((item, current) => current === index ? { ...item, instruction: event.target.value } : item) })} placeholder="明确、可执行的翻译要求"/><button type="button" className="text-button danger-link" onClick={() => onChange({ ...payload, rules: payload.rules.filter((_, current) => current !== index) })}>删除</button></article>)}</div><fieldset className="guide-sample"><legend>可选示例</legend><input value={payload.sample?.sourceText ?? ""} onChange={(event) => onChange({ ...payload, sample: { sourceText: event.target.value, targetText: payload.sample?.targetText ?? "", note: payload.sample?.note ?? "" } })} placeholder="示例原文"/><input value={payload.sample?.targetText ?? ""} onChange={(event) => onChange({ ...payload, sample: { sourceText: payload.sample?.sourceText ?? "", targetText: event.target.value, note: payload.sample?.note ?? "" } })} placeholder="示例译文"/><input value={payload.sample?.note ?? ""} onChange={(event) => onChange({ ...payload, sample: { sourceText: payload.sample?.sourceText ?? "", targetText: payload.sample?.targetText ?? "", note: event.target.value } })} placeholder="说明"/></fieldset></div>;
}

function TextStyleFields({ label, value, onChange }: { label: string; value: AssTextStyle; onChange: (value: AssTextStyle) => void }) {
  return <fieldset className="text-style-fields"><legend>{label}</legend><label><span>字体</span><input value={value.fontFamily} onChange={(event) => onChange({ ...value, fontFamily: event.target.value })}/></label><label><span>字号</span><input type="number" min="8" max="160" value={value.fontSizePx} onChange={(event) => onChange({ ...value, fontSizePx: event.target.valueAsNumber })}/></label><label><span>文字色</span><input type="color" value={value.textColor} onChange={(event) => onChange({ ...value, textColor: event.target.value })}/></label><label><span>描边色</span><input type="color" value={value.outlineColor} onChange={(event) => onChange({ ...value, outlineColor: event.target.value })}/></label><label><span>描边</span><input type="number" min="0" max="12" step="0.5" value={value.outlineWidthPx} onChange={(event) => onChange({ ...value, outlineWidthPx: event.target.valueAsNumber })}/></label><label><span>阴影色</span><input type="color" value={value.shadowColor} onChange={(event) => onChange({ ...value, shadowColor: event.target.value })}/></label><label><span>阴影</span><input type="number" min="0" max="12" step="0.5" value={value.shadowDepthPx} onChange={(event) => onChange({ ...value, shadowDepthPx: event.target.valueAsNumber })}/></label><label><span>位置</span><select value={value.position} onChange={(event) => onChange({ ...value, position: event.target.value as AssTextStyle["position"] })}><option value="top">顶部</option><option value="center">居中</option><option value="bottom">底部</option></select></label></fieldset>;
}

function SubtitleStyleEditor({ payload, onChange }: { payload: SubtitleStylePayload; onChange: (value: SubtitleStylePayload) => void }) {
  return <div className="structured-editor subtitle-style-editor"><header><div><span>ASS 样式</span><h3>字幕视觉与双语排布</h3></div><label className="inline-resource-field"><span>双语排布</span><select value={payload.bilingualLayout} onChange={(event) => onChange({ ...payload, bilingualLayout: event.target.value as SubtitleStylePayload["bilingualLayout"] })}><option value="target_only">仅译文</option><option value="source_top_target_bottom">原文上 / 译文下</option><option value="target_top_source_bottom">译文上 / 原文下</option></select></label></header><div className="subtitle-style-grid"><TextStyleFields label="主字幕" value={payload.primary} onChange={(primary) => onChange({ ...payload, primary })}/><TextStyleFields label="次字幕" value={payload.secondary} onChange={(secondary) => onChange({ ...payload, secondary })}/><div className="subtitle-style-preview" style={{ backgroundColor: payload.preview.backgroundColor }}><span>实时预览</span><div style={{ color: payload.primary.textColor, fontFamily: payload.primary.fontFamily, fontSize: `${Math.min(34, payload.primary.fontSizePx / 2)}px`, WebkitTextStroke: `${Math.min(2, payload.primary.outlineWidthPx)}px ${payload.primary.outlineColor}`, textShadow: `${payload.primary.shadowDepthPx}px ${payload.primary.shadowDepthPx}px ${payload.primary.shadowColor}` }}>{payload.preview.targetText}</div>{payload.bilingualLayout !== "target_only" ? <p style={{ color: payload.secondary.textColor, fontFamily: payload.secondary.fontFamily }}>{payload.preview.sourceText}</p> : null}</div></div><div className="preview-fields"><input value={payload.preview.sourceText} onChange={(event) => onChange({ ...payload, preview: { ...payload.preview, sourceText: event.target.value } })} placeholder="预览原文"/><input value={payload.preview.targetText} onChange={(event) => onChange({ ...payload, preview: { ...payload.preview, targetText: event.target.value } })} placeholder="预览译文"/><label><span>背景</span><input type="color" value={payload.preview.backgroundColor} onChange={(event) => onChange({ ...payload, preview: { ...payload.preview, backgroundColor: event.target.value } })}/></label><label><span>方向</span><select value={payload.preview.direction} onChange={(event) => onChange({ ...payload, preview: { ...payload.preview, direction: event.target.value as SubtitleStylePayload["preview"]["direction"] } })}><option value="auto">自动</option><option value="ltr">LTR</option><option value="rtl">RTL</option></select></label></div></div>;
}

function ExportPresetEditor({ payload, onChange }: { payload: ExportPresetPayload; onChange: (value: ExportPresetPayload) => void }) {
  return <div className="structured-editor export-preset-editor"><header><div><span>输出组合</span><h3>输出文件组合</h3></div><button type="button" className="btn btn-secondary" onClick={() => onChange({ ...payload, outputs: [...payload.outputs, { content: "target", format: "srt" }] })}>添加输出</button></header><div className="preset-output-list">{payload.outputs.map((output, index) => <article key={`${output.content}-${output.format}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><select value={output.content} onChange={(event) => onChange({ ...payload, outputs: payload.outputs.map((item, current) => current === index ? { ...item, content: event.target.value as typeof output.content } : item) })}><option value="source">原文</option><option value="target">译文</option><option value="bilingual">双语</option></select><select value={output.format} onChange={(event) => onChange({ ...payload, outputs: payload.outputs.map((item, current) => current === index ? { ...item, format: event.target.value as typeof output.format } : item) })}><option value="srt">SRT</option><option value="vtt">VTT</option><option value="ass">ASS</option></select><button type="button" className="text-button danger-link" disabled={payload.outputs.length === 1} onClick={() => onChange({ ...payload, outputs: payload.outputs.filter((_, current) => current !== index) })}>删除</button></article>)}</div><div className="preset-settings"><label><span>文件名模板</span><input value={payload.fileNameTemplate} onChange={(event) => onChange({ ...payload, fileNameTemplate: event.target.value })} placeholder="{project}-{language}"/></label><label><span>输出位置</span><select value={payload.destination.kind} onChange={(event) => onChange({ ...payload, destination: event.target.value === "project_exports" ? { kind: "project_exports" } : { kind: "custom_directory", directory: "" } })}><option value="project_exports">项目 exports</option><option value="custom_directory">自定义目录</option></select></label>{payload.destination.kind === "custom_directory" ? <label><span>自定义目录</span><input value={payload.destination.directory} onChange={(event) => onChange({ ...payload, destination: { kind: "custom_directory", directory: event.target.value } })}/></label> : null}<label className="preset-check"><input type="checkbox" checked={payload.burnVideo} onChange={(event) => onChange({ ...payload, burnVideo: event.target.checked })}/>同时烧录视频</label></div></div>;
}
