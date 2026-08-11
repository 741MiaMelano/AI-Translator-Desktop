import { useState } from "react";
import type { AsrModelId, Project } from "../../../domain/workspace";
import {
  OUTPUT_FORMAT_OPTIONS,
  PROVIDER_OPTIONS,
  SOURCE_LANGUAGE_OPTIONS,
  TARGET_LANGUAGE_OPTIONS,
  useWorkspace,
  optionsWithCurrent,
} from "../../../state/WorkspaceContext";
import { useModelOptionsFor } from "../../../state/use-model-options";
import Button from "../../ui/Button";
import Card from "../../ui/Card";
import Select from "../../ui/Select";
import { describeTargetLanguageError } from "./format";

interface ProjectConfigPanelProps {
  project: Project;
  open: boolean;
  onToggle: () => void;
}

function TargetLanguagePicker({
  value,
  onToggle,
  error,
}: {
  value: string[];
  onToggle: (language: string) => void;
  error?: string | null;
}) {
  return (
    <div>
      <p className="mb-1 text-[12.5px] text-[var(--color-text-muted)]">目标语言</p>
      <div className="flex flex-wrap gap-1.5">
        {TARGET_LANGUAGE_OPTIONS.map((language) => {
          const active = value.includes(language);
          // 「至少保留一个」是可预判的约束：直接禁用最后一个已选项，
          // 而不是等用户点掉再弹一条错误。
          const isLastSelected = active && value.length === 1;

          return (
            <button
              key={language}
              type="button"
              aria-pressed={active}
              disabled={isLastSelected}
              title={isLastSelected ? "至少保留一个目标语言；先添加其它语言再取消这一个" : undefined}
              onClick={() => onToggle(language)}
              className={`inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[6px] border px-3 text-[13px] transition disabled:cursor-not-allowed disabled:opacity-45 ${
                active
                  ? "metal-gold border-transparent font-medium"
                  : "border-line-strong bg-card text-[var(--color-text-main)] hover:border-gold hover:text-gold-dark"
              }`}
            >
              {language}
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-1.5 text-[11.5px] leading-5 text-stop">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ConfigSummary({ project }: { project: Project }) {
  const rows: Array<[string, string]> = [
    ["源语言", project.config.sourceLanguage],
    ["目标语言", project.config.targetLanguages.join(" / ") || "未配置"],
    ["翻译服务", project.config.provider],
    ["模型", project.config.model],
    ["ASR 模型", project.config.asrModelId ?? "使用全局默认"],
    ["术语快照", project.config.glossary],
    ["风格指南", project.config.styleGuide],
    ["导出格式", project.config.outputFormat],
  ];

  return (
    <div className="space-y-1.5">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex min-h-8 items-center justify-between gap-3 rounded-[6px] border border-line bg-card-soft px-2.5 py-1.5"
        >
          <span className="shrink-0 text-[11.5px] text-[var(--color-text-muted)]">{label}</span>
          <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--color-text-main)]" title={value}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ConfigEditor({ project }: { project: Project }) {
  const { updateProjectConfig, setProjectTargetLanguages, glossaryOptions, styleGuideOptions, capabilities } = useWorkspace();
  const [targetLanguageError, setTargetLanguageError] = useState<string | null>(null);
  // 与「开始翻译」页同一份取数规则：优先列「拉取模型」的真实结果，注册表只作兜底。
  // 旧版直接调 getTranslationModelOptions：拉取到的型号在这里永远选不到，
  // 且 provider 失配时会在 render 期抛异常炸掉整页。
  const modelOptions = useModelOptionsFor(project.config.provider);
  const asrModelOptions = capabilities.providers.find((provider) => provider.kind === "asr")?.models ?? ["small"];

  const handleTargetLanguageToggle = (language: string) => {
    const current = project.config.targetLanguages;
    const next = current.includes(language)
      ? current.filter((item) => item !== language)
      : [...current, language];

    setTargetLanguageError(describeTargetLanguageError(setProjectTargetLanguages(project.id, next)));
  };

  return (
    <div className="space-y-2.5">
      <Select
        label="源语言"
        options={SOURCE_LANGUAGE_OPTIONS}
        value={project.config.sourceLanguage}
        onChange={(event) => updateProjectConfig(project.id, { sourceLanguage: event.target.value })}
      />
      <TargetLanguagePicker
        value={project.config.targetLanguages}
        onToggle={handleTargetLanguageToggle}
        error={targetLanguageError}
      />
      <Select
        label="翻译服务"
        options={optionsWithCurrent(PROVIDER_OPTIONS, project.config.provider)}
        value={project.config.provider}
        onChange={(event) => updateProjectConfig(project.id, { provider: event.target.value })}
      />
      <Select
        label="模型"
        options={optionsWithCurrent(modelOptions, project.config.model)}
        value={project.config.model}
        onChange={(event) => updateProjectConfig(project.id, { model: event.target.value })}
      />
      <Select
        label="ASR 模型覆盖"
        options={["使用全局默认", ...asrModelOptions]}
        value={project.config.asrModelId ?? "使用全局默认"}
        onChange={(event) => updateProjectConfig(project.id, {
          asrModelId: event.target.value === "使用全局默认" ? null : event.target.value as AsrModelId,
        })}
      />
      <Select
        label="术语快照"
        options={optionsWithCurrent(glossaryOptions, project.config.glossary)}
        value={project.config.glossary}
        onChange={(event) => updateProjectConfig(project.id, { glossary: event.target.value })}
      />
      <Select
        label="风格指南"
        options={optionsWithCurrent(styleGuideOptions, project.config.styleGuide)}
        value={project.config.styleGuide}
        onChange={(event) => updateProjectConfig(project.id, { styleGuide: event.target.value })}
      />
      <Select
        label="导出格式"
        options={OUTPUT_FORMAT_OPTIONS}
        value={project.config.outputFormat}
        onChange={(event) => updateProjectConfig(project.id, { outputFormat: event.target.value })}
      />
    </div>
  );
}

/** 项目配置：摘要与编辑态占用同一个位置，避免展开后出现一套重复字段。 */
export default function ProjectConfigPanel({ project, open, onToggle }: ProjectConfigPanelProps) {
  return (
    <Card
      id="project-config-panel"
      title="项目配置"
      actions={
        <Button variant="ghost" onClick={onToggle}>
          {open ? "完成修改" : "修改配置"}
        </Button>
      }
    >
      {open ? <ConfigEditor project={project} /> : <ConfigSummary project={project} />}
      <p className="mt-2.5 rounded-[6px] border border-line bg-card-soft px-2.5 py-2 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
        {open
          ? "修改会自动保存到当前项目；已有译文不会自动重跑。"
          : "修改配置只影响下一次处理，不会覆盖已有译文。"}
      </p>
    </Card>
  );
}
