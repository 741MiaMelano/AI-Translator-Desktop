import { useMemo } from "react";
import { TARGET_LANGUAGE_OPTIONS, type Project } from "../domain/workspace";
import {
  GLOSSARY_NONE,
  STYLE_GUIDE_NONE,
  getTranslationModelOptions,
  useWorkspace,
} from "../state/WorkspaceContext";

/** 翻译方案的四个下拉加目标语言。方案改动即时写回项目配置。 */
/** 后端上报的模型清单优先；没有上报时才退回注册表。 */
export function translationModelsFor(
  workspace: ReturnType<typeof useWorkspace>,
  provider: string,
  current = "",
) {
  const runtime = workspace.capabilities.providers.find((entry) => entry.name === provider);
  let models = runtime?.models.length ? [...runtime.models] : [];
  if (!models.length) {
    try { models = [...getTranslationModelOptions(provider)]; } catch { models = []; }
  }
  return current && !models.includes(current) ? [current, ...models] : models;
}

export function TranslationPlanFields({
  project,
  onLanguageError,
}: {
  project: Project;
  onLanguageError?: (message: string | null) => void;
}) {
  const workspace = useWorkspace();
  const config = project.config;

  const providerOptions = useMemo(() => {
    const names = workspace.capabilities.providers.filter((entry) => entry.kind === "llm").map((entry) => entry.name);
    return names.includes(config.provider) ? names : [config.provider, ...names];
  }, [config.provider, workspace.capabilities.providers]);

  const modelOptions = translationModelsFor(workspace, config.provider, config.model);

  const toggleLanguage = (language: string, checked: boolean) => {
    const next = checked
      ? [...config.targetLanguages, language]
      : config.targetLanguages.filter((value) => value !== language);
    onLanguageError?.(workspace.setProjectTargetLanguages(project.id, next));
  };

  return (
    <>
      <div className="settings-form-grid translate-plan-grid">
        <label><span>Provider</span><select value={config.provider} onChange={(event) => { const provider = event.target.value; workspace.updateProjectConfig(project.id, { provider, model: translationModelsFor(workspace, provider)[0] ?? "" }); }}>{providerOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>模型</span><select value={config.model} onChange={(event) => workspace.updateProjectConfig(project.id, { model: event.target.value })}>{modelOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label><span>术语表</span><select value={config.glossary} onChange={(event) => workspace.updateProjectConfig(project.id, { glossary: event.target.value })}>{workspace.glossaryOptions.map((value) => <option key={value} value={value}>{value === GLOSSARY_NONE ? "不使用术语表" : value}</option>)}</select></label>
        <label><span>风格指南</span><select value={config.styleGuide} onChange={(event) => workspace.updateProjectConfig(project.id, { styleGuide: event.target.value })}>{workspace.styleGuideOptions.map((value) => <option key={value} value={value}>{value === STYLE_GUIDE_NONE ? "不使用风格指南" : value}</option>)}</select></label>
      </div>

      <fieldset className="target-language-fieldset"><legend>目标语言</legend><div>{TARGET_LANGUAGE_OPTIONS.map((language) => <label key={language}><input type="checkbox" checked={config.targetLanguages.includes(language)} onChange={(event) => toggleLanguage(language, event.target.checked)}/><span>{language}</span></label>)}</div></fieldset>
    </>
  );
}
