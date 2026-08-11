import { Download, Languages, Plus, ScanText, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import Button from "../../ui/Button";
import EmptyState from "../../ui/EmptyState";
import Input from "../../ui/Input";
import Toggle from "../../ui/Toggle";
import type {
  GlossaryEntry,
  GlossaryLanguagePair,
  GlossaryPayload,
} from "../../../domain/resource-library";
import { newId } from "./payload";
import { extractFrequentTerms, type FrequentTermCandidate } from "../../../domain/term-extraction";
import {
  parseGlossaryDelimited,
  serializeGlossaryDelimited,
  type GlossaryDelimitedFormat,
} from "../../../domain/glossary-delimited";
import { getActiveSourceTrack, type Project } from "../../../domain/workspace";

interface GlossaryEditorProps {
  payload: GlossaryPayload;
  onChange: (next: GlossaryPayload) => void;
  projects: Project[];
}

const SELECT_FIELD =
  "control-surface h-8 min-w-[180px] rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold";

function newPair(): GlossaryLanguagePair {
  return { sourceLanguageCode: "en-US", targetLanguageCode: "zh-CN", entries: [] };
}

function downloadGlossary(payload: GlossaryPayload, format: GlossaryDelimitedFormat) {
  const url = URL.createObjectURL(new Blob(
    [serializeGlossaryDelimited(payload, format)],
    { type: format === "csv" ? "text/csv;charset=utf-8" : "text/tab-separated-values;charset=utf-8" },
  ));
  const link = document.createElement("a");
  link.href = url;
  link.download = `glossary-${new Date().toISOString().slice(0, 10)}.${format}`;
  link.click();
  URL.revokeObjectURL(url);
}

function EntryRows({
  entries,
  onChange,
}: {
  entries: GlossaryEntry[];
  onChange: (next: GlossaryEntry[]) => void;
}) {
  const patch = (index: number, value: Partial<GlossaryEntry>) => {
    onChange(entries.map((entry, current) => (current === index ? { ...entry, ...value } : entry)));
  };

  return (
    <tbody className="divide-y divide-[var(--color-border)] bg-card">
      {entries.map((entry, index) => (
        <tr key={entry.id}>
          <td className="px-2 py-1.5 align-middle">
            <Input
              value={entry.source}
              placeholder="原文"
              onChange={(event) => patch(index, { source: event.target.value })}
            />
          </td>
          <td className="px-2 py-1.5 align-middle">
            <Input
              value={entry.target}
              placeholder="固定译文"
              onChange={(event) => patch(index, { target: event.target.value })}
            />
          </td>
          <td className="px-2 py-1.5 align-middle">
            <Toggle
              checked={entry.enabled}
              onChange={(checked) => patch(index, { enabled: checked })}
              title="关掉之后这条术语不参与翻译，但会留在表里"
            />
          </td>
          <td className="px-2 py-1.5 align-middle">
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 size={14} />}
              aria-label={`删除术语 ${entry.source || index + 1}`}
              title="删除这条术语"
              onClick={() => onChange(entries.filter((_, current) => current !== index))}
            />
          </td>
        </tr>
      ))}
    </tbody>
  );
}

/**
 * 术语表的结构化编辑：原文 / 固定译文 / 是否启用三列。
 * 旧版这里只有一个手写 JSON 的 textarea，加一条术语要自己保证 id 唯一、enabled 是布尔值。
 */
export default function GlossaryEditor({ payload, onChange, projects }: GlossaryEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pairIndex, setPairIndex] = useState(0);
  const [projectId, setProjectId] = useState("");
  const [candidates, setCandidates] = useState<FrequentTermCandidate[]>([]);
  const [candidateTargets, setCandidateTargets] = useState<Record<string, string>>({});
  const [extractMessage, setExtractMessage] = useState("");
  const [exchangeMessage, setExchangeMessage] = useState("");
  const pairs = Array.isArray(payload.languagePairs) ? payload.languagePairs : [];
  const index = Math.min(pairIndex, Math.max(pairs.length - 1, 0));
  const pair = pairs[index] as GlossaryLanguagePair | undefined;
  const entries = pair && Array.isArray(pair.entries) ? pair.entries : [];
  const eligibleProjects = projects.filter(
    (project) => !project.trashedAt && (getActiveSourceTrack(project)?.segments.length ?? 0) > 0,
  );
  const selectedProjectId = eligibleProjects.some((project) => project.id === projectId)
    ? projectId
    : eligibleProjects[0]?.id ?? "";

  const writePairs = (next: GlossaryLanguagePair[]) => onChange({ ...payload, languagePairs: next });
  const patchPair = (value: Partial<GlossaryLanguagePair>) => {
    writePairs(pairs.map((item, current) => (current === index ? { ...item, ...value } : item)));
  };
  const addPair = () => {
    writePairs([...pairs, newPair()]);
    setPairIndex(pairs.length);
  };
  const importFile = async (file: File) => {
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("导入文件超过 2 MB");
      const extension = file.name.toLocaleLowerCase().split(".").pop();
      if (extension !== "csv" && extension !== "tsv") throw new Error("请选择 CSV 或 TSV 文件");
      const imported = parseGlossaryDelimited(await file.text(), {
        format: extension,
        defaultSourceLanguageCode: pair?.sourceLanguageCode || "en-US",
        defaultTargetLanguageCode: pair?.targetLanguageCode || "zh-CN",
        idFactory: () => newId("term"),
      });
      const next = pairs.map((item) => ({ ...item, entries: [...(item.entries ?? [])] }));
      let added = 0;
      let skipped = 0;
      for (const incoming of imported.languagePairs) {
        let destination = next.find((item) =>
          item.sourceLanguageCode === incoming.sourceLanguageCode &&
          item.targetLanguageCode === incoming.targetLanguageCode);
        if (!destination) {
          destination = { ...incoming, entries: [] };
          next.push(destination);
        }
        const existing = new Set(destination.entries.map((entry) =>
          `${entry.source.trim().toLocaleLowerCase()}\u0000${entry.target.trim().toLocaleLowerCase()}`));
        for (const entry of incoming.entries) {
          const key = `${entry.source.toLocaleLowerCase()}\u0000${entry.target.toLocaleLowerCase()}`;
          if (existing.has(key)) {
            skipped += 1;
          } else {
            destination.entries.push(entry);
            existing.add(key);
            added += 1;
          }
        }
      }
      if (added) writePairs(next);
      setExchangeMessage(`已导入 ${added} 条到草稿${skipped ? `，跳过 ${skipped} 条重复项` : ""}；保存后生效。`);
    } catch (error) {
      setExchangeMessage(error instanceof Error ? error.message : "术语文件导入失败");
    }
  };
  const filePicker = (
    <input
      ref={fileInputRef}
      type="file"
      className="hidden"
      accept=".csv,.tsv,text/csv,text/tab-separated-values"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (file) void importFile(file);
      }}
    />
  );
  const exchangeStatus = exchangeMessage ? (
    <p role="status" className="text-[11.5px] text-[var(--color-text-muted)]">{exchangeMessage}</p>
  ) : null;
  const extract = () => {
    const project = eligibleProjects.find((item) => item.id === selectedProjectId);
    const track = project ? getActiveSourceTrack(project) : null;
    if (!track || !pair) return;
    const existing = new Set(entries.map((entry) => entry.source.trim().toLocaleLowerCase()));
    const next = extractFrequentTerms(track.segments, {
      languageCode: pair.sourceLanguageCode || project?.config.sourceLanguage || "auto",
      minOccurrences: 2,
      limit: 30,
    }).filter((candidate) => !existing.has(candidate.term.toLocaleLowerCase()));
    setCandidates(next);
    setCandidateTargets({});
    setExtractMessage(next.length ? `找到 ${next.length} 个候选；填写固定译文后再加入。` : "没有找到重复两次以上的新术语。");
  };
  const addCandidate = (candidate: FrequentTermCandidate) => {
    const target = candidateTargets[candidate.term]?.trim();
    if (!target) return;
    patchPair({
      entries: [...entries, {
        id: newId("term"),
        source: candidate.term,
        target,
        enabled: true,
        tags: ["auto-extracted"],
        note: `从字幕提取，出现 ${candidate.count} 次`,
      }],
    });
    setCandidates((current) => current.filter((item) => item.term !== candidate.term));
  };

  if (!pair) {
    return (
      <EmptyState
        icon={<Languages size={20} />}
        title="还没有语言对"
        description="术语按「源语言 → 目标语言」分组存放，先建一组再往里加词。"
        action={(
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button variant="primary" icon={<Plus size={14} />} onClick={addPair}>新增语言对</Button>
              <Button variant="secondary" icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()}>
                导入 CSV/TSV
              </Button>
              {filePicker}
            </div>
            {exchangeStatus}
          </div>
        )}
      />
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-0">
          <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">语言对</span>
          <select
            value={index}
            onChange={(event) => setPairIndex(Number(event.target.value))}
            className={SELECT_FIELD}
            title="每组语言对维护自己的一份术语"
          >
            {pairs.map((item, current) => (
              <option key={`${item.sourceLanguageCode}-${item.targetLanguageCode}-${current}`} value={current}>
                {item.sourceLanguageCode} → {item.targetLanguageCode}（{item.entries?.length ?? 0} 条）
              </option>
            ))}
          </select>
        </label>
        <Input
          label="源语言代码"
          value={pair.sourceLanguageCode}
          className="w-[140px]"
          onChange={(event) => patchPair({ sourceLanguageCode: event.target.value })}
        />
        <Input
          label="目标语言代码"
          value={pair.targetLanguageCode}
          className="w-[140px]"
          onChange={(event) => patchPair({ targetLanguageCode: event.target.value })}
        />
        <Button variant="secondary" icon={<Plus size={14} />} onClick={addPair}>新增语言对</Button>
        <Button
          variant="ghost"
          icon={<Trash2 size={14} />}
          onClick={() => {
            writePairs(pairs.filter((_, current) => current !== index));
            setPairIndex(Math.max(index - 1, 0));
          }}
          title="删除这组语言对及其下的全部术语"
        >
          删除语言对
        </Button>
      </div>

      <div className="rounded-[6px] border border-line bg-card-soft p-2.5" data-testid="glossary-term-extractor">
        <div className="flex flex-wrap items-end gap-2">
          <label className="block min-w-0 flex-1">
            <span className="mb-1 block text-[12.5px] font-medium text-[var(--color-text-main)]">从项目字幕提取高频术语</span>
            <select
              aria-label="选择术语提取项目"
              value={selectedProjectId}
              onChange={(event) => setProjectId(event.target.value)}
              className={`${SELECT_FIELD} w-full`}
            >
              {eligibleProjects.length ? eligibleProjects.map((project) => (
                <option key={project.id} value={project.id}>{project.title}</option>
              )) : <option value="">没有含字幕的项目</option>}
            </select>
          </label>
          <Button
            variant="secondary"
            icon={<ScanText size={14} />}
            disabled={!selectedProjectId}
            title={selectedProjectId ? "扫描字幕中重复出现的词和短语" : "先创建或导入一个含字幕的项目"}
            onClick={extract}
          >
            提取候选
          </Button>
        </div>
        {extractMessage ? <p className="mt-2 text-[11.5px] text-[var(--color-text-muted)]">{extractMessage}</p> : null}
        {candidates.length ? (
          <div className="mt-2 max-h-64 space-y-1.5 overflow-auto">
            {candidates.map((candidate) => (
              <div key={candidate.term} className="grid items-center gap-2 rounded border border-line bg-card p-2 md:grid-cols-[minmax(0,1fr)_minmax(150px,0.8fr)_auto]">
                <div className="min-w-0">
                  <p className="truncate text-[12.5px] font-medium text-[var(--color-text-main)]" title={candidate.term}>{candidate.term}</p>
                  <p className="truncate text-[11px] text-[var(--color-text-muted)]" title={candidate.example}>出现 {candidate.count} 次 · {candidate.example}</p>
                </div>
                <Input
                  aria-label={`${candidate.term} 的固定译文`}
                  placeholder="固定译文"
                  value={candidateTargets[candidate.term] ?? ""}
                  onChange={(event) => setCandidateTargets((current) => ({ ...current, [candidate.term]: event.target.value }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!candidateTargets[candidate.term]?.trim()}
                  title={candidateTargets[candidate.term]?.trim() ? "加入当前语言对" : "先填写固定译文"}
                  onClick={() => addCandidate(candidate)}
                >
                  加入术语表
                </Button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-[6px] border border-line">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead className="bg-card-soft text-[11.5px] text-[var(--color-text-muted)]">
            <tr>
              <th className="whitespace-nowrap px-2 py-1.5 font-medium">原文</th>
              <th className="whitespace-nowrap px-2 py-1.5 font-medium">固定译文</th>
              <th className="w-[92px] whitespace-nowrap px-2 py-1.5 font-medium">启用</th>
              <th className="w-[52px] px-2 py-1.5 font-medium" aria-label="删除" />
            </tr>
          </thead>
          <EntryRows entries={entries} onChange={(next) => patchPair({ entries: next })} />
        </table>
        {entries.length === 0 ? (
          <div className="border-t border-line px-3 py-4 text-center text-[12.5px] text-[var(--color-text-muted)]">
            <p>这组语言对还没有术语。示例术语：GPU → 图形处理器。</p>
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() => patchPair({
                entries: [...entries, { id: newId("term"), source: "GPU", target: "图形处理器", enabled: true }],
              })}
            >
              添加示例术语
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          icon={<Plus size={14} />}
          onClick={() => patchPair({
            entries: [...entries, { id: newId("term"), source: "", target: "", enabled: true }],
          })}
        >
          添加术语
        </Button>
        <span className="tabular text-[11.5px] text-[var(--color-text-muted)]">
          共 {entries.length} 条 · 启用 {entries.filter((entry) => entry.enabled).length} 条
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-line bg-card-soft p-2.5">
        {filePicker}
        <Button variant="secondary" icon={<Upload size={14} />} onClick={() => fileInputRef.current?.click()}>
          导入 CSV/TSV
        </Button>
        <Button variant="outline" icon={<Download size={14} />} onClick={() => downloadGlossary(payload, "csv")}>
          导出 CSV
        </Button>
        <Button variant="outline" icon={<Download size={14} />} onClick={() => downloadGlossary(payload, "tsv")}>
          导出 TSV
        </Button>
        {exchangeStatus ?? (
          <span className="text-[11.5px] text-[var(--color-text-muted)]">
            支持中英文表头；导入先进入草稿，不会直接覆盖已保存内容。
          </span>
        )}
      </div>
    </div>
  );
}
