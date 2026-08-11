import { Plus, Trash2 } from "lucide-react";
import Button from "../../ui/Button";
import Input from "../../ui/Input";
import Toggle from "../../ui/Toggle";
import type { StyleGuidePayload, StyleGuideRule } from "../../../domain/resource-library";
import { newId } from "./payload";

interface StyleGuideEditorProps {
  payload: StyleGuidePayload;
  onChange: (next: StyleGuidePayload) => void;
}

const TEXTAREA =
  "control-surface w-full rounded-[6px] border border-line-strong bg-card px-2.5 py-1.5 text-[13px] leading-6 text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold";

function parseList(value: string) {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const STYLE_GUIDE_TEMPLATES: Array<{ name: string; description: string; payload: StyleGuidePayload }> = [
  {
    name: "纪录片",
    description: "自然旁白、适度压缩",
    payload: {
      targetLanguageCode: "zh-CN",
      tags: ["自然", "旁白", "轻压缩"],
      scenes: ["纪录片", "访谈"],
      rules: [
        { id: "documentary-tone", title: "语气", instruction: "保持自然、克制的旁白口吻，不做文案式拔高。", enabled: true },
        { id: "documentary-length", title: "长度", instruction: "长句优先拆短，保留事实与逻辑主干。", enabled: true },
      ],
    },
  },
  {
    name: "影视对白",
    description: "口语自然、贴近人物",
    payload: {
      targetLanguageCode: "zh-CN",
      tags: ["口语", "对白", "人物语气"],
      scenes: ["电影", "剧集", "短视频"],
      rules: [
        { id: "dialogue-spoken", title: "口语", instruction: "使用自然口语，避免书面腔和逐词直译。", enabled: true },
        { id: "dialogue-character", title: "人物", instruction: "保留人物身份、情绪和彼此关系带来的语气差异。", enabled: true },
      ],
    },
  },
  {
    name: "课程讲解",
    description: "术语准确、表达清楚",
    payload: {
      targetLanguageCode: "zh-CN",
      tags: ["准确", "清晰", "教学"],
      scenes: ["课程", "技术演示"],
      rules: [
        { id: "course-terms", title: "术语", instruction: "专业术语保持统一，优先采用术语库中的译法。", enabled: true },
        { id: "course-clarity", title: "清晰", instruction: "保留步骤与因果关系，用简洁完整的句子表达。", enabled: true },
      ],
    },
  },
];

function RuleCard({
  rule,
  index,
  onPatch,
  onRemove,
}: {
  rule: StyleGuideRule;
  index: number;
  onPatch: (value: Partial<StyleGuideRule>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="rounded-[6px] border border-line bg-card-soft p-2.5">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label={`第 ${index + 1} 条 · 标题`}
          value={rule.title}
          placeholder="例如：语气"
          className="min-w-[160px]"
          onChange={(event) => onPatch({ title: event.target.value })}
        />
        <div className="w-[132px] shrink-0">
          <Toggle
            checked={rule.enabled}
            label="启用"
            onChange={(checked) => onPatch({ enabled: checked })}
            title="关掉之后这条要求不会写进翻译提示"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={14} />}
          aria-label={`删除规则 ${rule.title || index + 1}`}
          title="删除这条要求"
          onClick={onRemove}
        />
      </div>
      <label className="mt-2 block">
        <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">具体要求</span>
        <textarea
          value={rule.instruction}
          rows={2}
          placeholder="用一句话说明希望译文怎么处理，例如「长句优先拆短，保留主干信息」"
          className={TEXTAREA}
          onChange={(event) => onPatch({ instruction: event.target.value })}
        />
      </label>
    </div>
  );
}

/**
 * 风格指南的结构化编辑：一条要求一张小卡，标题 + 具体要求 + 是否启用。
 * 旧版同样只有裸 JSON，用户得自己拼 rules 数组。
 */
export default function StyleGuideEditor({ payload, onChange }: StyleGuideEditorProps) {
  const rules = Array.isArray(payload.rules) ? payload.rules : [];
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  const scenes = Array.isArray(payload.scenes) ? payload.scenes : [];

  const writeRules = (next: StyleGuideRule[]) => onChange({ ...payload, rules: next });

  return (
    <div className="space-y-2.5">
      <div className="rounded-[6px] border border-line bg-card-soft p-2.5">
        <p className="text-[12.5px] font-medium text-[var(--color-text-main)]">内置模板</p>
        <p className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">套用后仍可逐条修改，保存前不会影响现有版本。</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STYLE_GUIDE_TEMPLATES.map((template) => (
            <Button
              key={template.name}
              size="sm"
              variant="outline"
              title={template.description}
              onClick={() => onChange(structuredClone(template.payload))}
            >
              {template.name}
            </Button>
          ))}
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <Input
          label="目标语言代码"
          value={payload.targetLanguageCode ?? ""}
          placeholder="zh-CN"
          onChange={(event) => onChange({ ...payload, targetLanguageCode: event.target.value })}
        />
        <Input
          label="标签"
          value={tags.join("、")}
          placeholder="自然、口语"
          hint="用逗号或顿号分隔"
          onChange={(event) => onChange({ ...payload, tags: parseList(event.target.value) })}
        />
        <Input
          label="适用场景"
          value={scenes.join("、")}
          placeholder="纪录片、访谈"
          hint="用逗号或顿号分隔"
          onChange={(event) => onChange({ ...payload, scenes: parseList(event.target.value) })}
        />
      </div>

      <div className="space-y-2">
        {rules.map((rule, index) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            index={index}
            onPatch={(value) => writeRules(rules.map((item, current) => (
              current === index ? { ...item, ...value } : item
            )))}
            onRemove={() => writeRules(rules.filter((_, current) => current !== index))}
          />
        ))}
        {rules.length === 0 ? (
          <p className="rounded-[6px] border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-[var(--color-text-muted)]">
            还没有任何要求，添加一条后会写进每次翻译的提示里。
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          icon={<Plus size={14} />}
          onClick={() => writeRules([...rules, { id: newId("rule"), title: "", instruction: "", enabled: true }])}
        >
          添加要求
        </Button>
        <span className="tabular text-[11.5px] text-[var(--color-text-muted)]">
          共 {rules.length} 条 · 启用 {rules.filter((rule) => rule.enabled).length} 条
        </span>
      </div>
    </div>
  );
}
