import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FolderCog,
  FolderInput,
  FolderOpen,
  Info,
  LockKeyhole,
  Palette,
  RefreshCcw,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { CapabilityReadinessItem } from "../contracts/desktop-api";
import { useNavigate } from "react-router-dom";
import Badge from "../components/ui/Badge";
import BottomActionBar from "../components/ui/BottomActionBar";
import Button from "../components/ui/Button";
import Card from "../components/ui/Card";
import EmptyState from "../components/ui/EmptyState";
import Input from "../components/ui/Input";
import Select from "../components/ui/Select";
import Tabs from "../components/ui/Tabs";
import Toggle from "../components/ui/Toggle";
import type { Project } from "../domain/workspace";
import { getTrashedProjects } from "../domain/workspace";
import PageHeader from "../layout/PageHeader";
import { isDesktopRuntime } from "../services/desktop-client";
import { useWorkspace } from "../state/WorkspaceContext";
import { useTheme } from "../theme/ThemeContext";
import type { SettingsMessage } from "./settings-controller";
import { useSettingsController } from "./settings-controller";

type Controller = ReturnType<typeof useSettingsController>;

const TABS = ["通用设置", "文件管理", "网络与凭据", "环境能力", "诊断与备份", "关于"];
/** 只有这两个 Tab 的字段走底部「保存设置」；其余 Tab 没有待落盘的表单，不该挂保存条 */
const FORM_TABS = ["文件管理", "网络与凭据"];

/** 与 components/ui/Select 的 FIELD 完全一致：项目下拉需要 value/label 分离，只能手写 select */
const FIELD =
  "control-surface h-8 w-full rounded-[6px] border border-line-strong bg-card px-2.5 text-[13px] text-[var(--color-text-main)] outline-none transition hover:border-gold focus:border-gold disabled:opacity-50";
const ROW = "rounded-[6px] border border-line bg-card-soft px-3 py-2";
const STORAGE_PATH_FIELDS = [
  { pathKey: "cachePath", label: "缓存目录" },
  { pathKey: "modelPath", label: "当前模型路径（只读）" },
  { pathKey: "backupPath", label: "备份目录" },
] as const;

/** 后端枚举 → 中文。渲染层不再出现 official / healthy / active 这类内部码 */
const SOURCE_LABELS: Record<string, string> = { official: "官方源", mirror: "国内镜像源", custom: "自定义源" };
const SOURCE_STATUS_LABELS: Record<string, string> = { healthy: "可用", unavailable: "不可达" };
const DOWNLOAD_STAGE_LABELS: Record<string, string> = {
  download: "下载中",
  verify: "校验中",
  extract: "解压中",
  staging: "写入暂存区",
  ready: "已就绪",
};
const DOWNLOAD_STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  paused: "已暂停",
  failed: "失败",
  ready: "已完成",
};
const ASSET_LABELS: Record<string, string> = {
  small: "Whisper.cpp small 模型",
  "whisper-cpp-cuda-12.4-x64": "Whisper.cpp CUDA 运行时",
  "qwen3-asr-transformers-cu128-x64": "Qwen3-ASR CUDA 运行时",
};
const label = (table: Record<string, string>, key: string) => table[key] ?? key;

function StatusBar({ message }: { message: SettingsMessage }) {
  const isError = message.tone === "error";
  const isSuccess = message.tone === "success";
  const Icon = isError ? AlertTriangle : isSuccess ? CheckCircle2 : Info;

  return (
    <div
      role={isError ? "alert" : "status"}
      className={`mb-3 flex items-start gap-2 rounded-[6px] border px-3 py-2 text-[12.5px] leading-5 ${
        isError
          ? "border-stop bg-stop-wash text-[var(--color-text-main)]"
          : isSuccess
            ? "border-ok bg-ok-wash text-[var(--color-text-main)]"
            : "border-line bg-card-soft text-[var(--color-text-muted)]"
      }`}
    >
      <Icon
        size={14}
        className={`mt-0.5 shrink-0 ${isError ? "text-stop" : isSuccess ? "text-ok" : "text-[var(--color-text-muted)]"}`}
      />
      <span className="min-w-0">{message.text}</span>
    </div>
  );
}

function ProjectPicker({
  label: fieldLabel,
  placeholder,
  projects,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  projects: Project[];
  value: string;
  onChange: (projectId: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[12.5px] text-[var(--color-text-muted)]">{fieldLabel}</span>
      <select className={FIELD} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.title}</option>
        ))}
      </select>
    </label>
  );
}

function GeneralTab() {
  const { mode, setMode } = useTheme();

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card
        title="界面主题"
        description="切换后立即生效并单独记住，不参与下方的保存与恢复默认。"
        actions={<Badge tone="gray">立即生效</Badge>}
      >
        <div className="space-y-2">
          <div className={ROW}>
            <Toggle checked={mode === "dark"} onChange={(checked) => setMode(checked ? "dark" : "light")} label="深色界面" />
          </div>
          <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
            侧栏底部的浅色／深色按钮与这里是同一个开关；「恢复默认设置」只重置应用设置，不会改动主题。
          </p>
        </div>
      </Card>
      <Card title="生效方式" actions={<Palette size={15} className="text-gold-dark" />}>
        <ul className="space-y-1.5 text-[12.5px] leading-5 text-[var(--color-text-muted)]">
          <li>· 主题：点击即生效，写入本机偏好。</li>
          <li>· 缓存、备份路径与下载源：改完需点底部「保存设置」；模型路径只能通过安全转移修改。</li>
          <li>· 能力探测、备份与诊断：每次点击都是一次真实的桌面端操作，不缓存结果。</li>
        </ul>
      </Card>
    </div>
  );
}

function FilesTab({ controller }: { controller: Controller }) {
  const { projects, restoreProject, clearTrashedProjects } = useWorkspace();
  const settings = controller.settings;
  const trashedProjects = getTrashedProjects(projects);

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card
        title="全局存储路径"
        description="只保存应用级路径，不写入项目配置。"
        actions={<FolderCog size={15} className="text-gold-dark" />}
      >
        <div className="space-y-2.5">
          {STORAGE_PATH_FIELDS.map(({ pathKey, label }) => (
            <div key={pathKey} className="space-y-2">
              <div className="relative">
                <Input
                  label={label}
                  value={settings?.[pathKey] ?? ""}
                  className={`pr-9 ${pathKey === "modelPath" ? "bg-card-soft" : ""}`}
                  disabled={!settings}
                  readOnly={pathKey === "modelPath"}
                  onChange={(event) => {
                    if (pathKey !== "modelPath") controller.updateSettings({ [pathKey]: event.target.value });
                  }}
                />
                {pathKey === "modelPath" ? (
                  <span className="absolute bottom-1 right-1 grid h-6 w-6 place-items-center text-[var(--color-text-muted)]" title="当前模型路径只能通过下方转移功能修改">
                    <LockKeyhole size={14} />
                  </span>
                ) : (
                  <button
                    type="button"
                    className="absolute bottom-1 right-1 grid h-6 w-6 place-items-center rounded-[5px] text-[var(--color-text-muted)] transition hover:bg-card-soft hover:text-gold-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`选择${label}`}
                    title={`选择${label}`}
                    disabled={!settings || controller.busy}
                    onClick={() => void controller.selectDirectory(pathKey)}
                  >
                    <FolderOpen size={14} />
                  </button>
                )}
              </div>
              {pathKey === "modelPath" ? (
                <div className={`${ROW} space-y-2.5`}>
                  <div className="relative">
                    <Input
                      label="转移到"
                      value={controller.modelTransferDestination}
                      placeholder="请选择一个空目录"
                      className="pr-9"
                      readOnly
                      disabled={!settings || controller.busy}
                    />
                    <button
                      type="button"
                      className="absolute bottom-1 right-1 grid h-6 w-6 place-items-center rounded-[5px] text-[var(--color-text-muted)] transition hover:bg-card hover:text-gold-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="选择模型转移目录"
                      title="选择模型转移目录"
                      disabled={!settings || controller.busy || controller.dirty}
                      onClick={() => void controller.selectModelTransferDestination()}
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
                      复制并校验成功后，当前模型路径会更新为上方所选目录并自动重启。
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      icon={<FolderInput size={14} />}
                      disabled={!settings || !controller.modelTransferDestination || controller.busy || controller.dirty || controller.downloads.items.some((item) => item.status === "active")}
                      title={controller.dirty ? "请先保存或撤销当前设置修改" : "转移现有模型"}
                      onClick={() => controller.transferModels()}
                    >转移现有模型</Button>
                  </div>
                  {controller.modelTransferProgress ? (
                    <div className="rounded-[6px] border border-line bg-card px-2.5 py-2" role="status">
                      <div className="mb-1.5 flex items-center justify-between gap-3 text-[11.5px]">
                        <span className="text-[var(--color-text-muted)]">{controller.modelTransferProgress.message}</span>
                        <span className="shrink-0 font-medium text-[var(--color-text-main)]">{controller.modelTransferProgress.progress}%</span>
                      </div>
                      <div
                        className="h-1.5 overflow-hidden rounded-full bg-line"
                        role="progressbar"
                        aria-label="模型转移进度"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={controller.modelTransferProgress.progress}
                      >
                        <div className={`h-full rounded-full transition-[width] ${controller.modelTransferProgress.stage === "failed" ? "bg-stop" : controller.modelTransferProgress.stage === "completed" ? "bg-ok" : "bg-gold"}`} style={{ width: `${controller.modelTransferProgress.progress}%` }} />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
          <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">
            缓存和备份目录可直接修改；当前模型路径已锁定，只能通过上方转移功能安全变更。
          </p>
        </div>
      </Card>
      <Card
        title="项目回收站"
        actions={<Badge tone={trashedProjects.length ? "red" : "gray"}>{trashedProjects.length} 个</Badge>}
      >
        <div className="space-y-2">
          {trashedProjects.map((project) => (
            <div key={project.id} className={`${ROW} flex items-center justify-between gap-3`}>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-[var(--color-text-main)]">{project.title}</p>
                <p className="truncate text-[11.5px] text-[var(--color-text-muted)]">{project.sourceFileName}</p>
              </div>
              <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} onClick={() => restoreProject(project.id)}>恢复</Button>
            </div>
          ))}
          {trashedProjects.length ? (
            <div className="flex items-center justify-between gap-3 pt-1">
              <p className="text-[11.5px] leading-5 text-[var(--color-text-muted)]">清空后无法恢复，包含项目内的全部译文与人工稿。</p>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={14} />}
                onClick={async () => {
                  if (window.confirm(`将永久删除 ${trashedProjects.length} 个项目，无法撤销，是否继续？`)) await clearTrashedProjects();
                }}
              >清空回收站</Button>
            </div>
          ) : (
            <EmptyState icon={<Trash2 size={20} />} title="项目回收站为空" description="删除项目后会先进入这里，可以恢复，也可以永久清空。" />
          )}
        </div>
      </Card>
    </div>
  );
}

function NetworkTab({ controller, onOpenCredentials }: { controller: Controller; onOpenCredentials: () => void }) {
  const settings = controller.settings;

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card title="模型下载源" actions={<Download size={15} className="text-gold-dark" />}>
        <div className="space-y-2.5">
          <Select
            label="首选下载源"
            options={["官方源", "国内镜像", "自定义 HTTPS"]}
            value={settings?.downloadSource === "mirror" ? "国内镜像" : settings?.downloadSource === "custom" ? "自定义 HTTPS" : "官方源"}
            disabled={!settings}
            onChange={(event) => controller.updateSettings({ downloadSource: event.target.value === "国内镜像" ? "mirror" : event.target.value === "自定义 HTTPS" ? "custom" : "official" })}
          />
          {settings?.downloadSource === "custom" ? (
            <Input label="自定义模型文件地址" value={settings.customDownloadUrl} onChange={(event) => controller.updateSettings({ customDownloadUrl: event.target.value })} />
          ) : null}
          <Button variant="outline" icon={<RefreshCcw size={14} />} onClick={() => void controller.probe()} disabled={controller.busy}>检测并更新源状态</Button>
          <div className="space-y-1.5">
            {controller.downloads.sources.map((source) => (
              <div key={source.source} className={`${ROW} flex items-center justify-between gap-3 text-[12.5px]`}>
                <span className="min-w-0 truncate">{label(SOURCE_LABELS, source.source)}</span>
                <Badge tone={source.status === "healthy" ? "green" : "red"}>
                  {label(SOURCE_STATUS_LABELS, source.status)}
                  {source.latencyMs === null ? "" : ` · ${source.latencyMs} 毫秒`}
                </Badge>
              </div>
            ))}
            {!controller.downloads.sources.length ? (
              <p className="text-[12.5px] text-[var(--color-text-muted)]">还没有源探测结果，点上方按钮检测一次。</p>
            ) : null}
          </div>
        </div>
      </Card>
      <Card
        title="凭据状态"
        description="只显示是否配置，密钥不会被回显。"
        actions={<LockKeyhole size={15} className="text-gold-dark" />}
      >
        <div className="space-y-2">
          {controller.credentials.map((credential) => (
            <div key={credential.credentialId ?? credential.providerId} className={ROW}>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-text-main)]">
                  {credential.label ?? credential.providerId ?? credential.credentialId}
                </span>
                <Badge tone={credential.configured ? "green" : "gray"}>{credential.configured ? "已配置" : "未配置"}</Badge>
              </div>
              {credential.updatedAt ? (
                <p className="tabular mt-1 text-[11.5px] text-[var(--color-text-muted)]">更新：{credential.updatedAt}</p>
              ) : null}
            </div>
          ))}
          {!controller.credentials.length ? (
            <p className="text-[12.5px] text-[var(--color-text-muted)]">没有已配置凭据。</p>
          ) : null}
          <Button variant="primary" onClick={onOpenCredentials}>更新、删除或连接复检</Button>
        </div>
      </Card>
    </div>
  );
}

function CapabilityCard({
  title,
  capabilities,
  onRepair,
}: {
  title: string;
  capabilities: CapabilityReadinessItem[] | undefined;
  onRepair: (action: string | null) => void;
}) {
  return (
    <Card title={title} actions={<ShieldCheck size={15} className="text-gold-dark" />}>
      <div className="space-y-2">
        {(capabilities ?? []).map((item) => (
          <div key={item.id} className={ROW}>
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[13px] font-medium text-[var(--color-text-main)]">{item.label}</span>
              <Badge tone={item.available ? "green" : "gold"}>{item.available ? "可用" : "不可用"}</Badge>
            </div>
            {!item.available ? (
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 flex-1 text-[11.5px] leading-5 text-[var(--color-text-muted)]">{item.reason}</p>
                <Button variant="secondary" size="sm" onClick={() => onRepair(item.repairAction)}>修复/查看</Button>
              </div>
            ) : null}
          </div>
        ))}
        {!capabilities ? <p className="text-[12.5px] text-[var(--color-text-muted)]">等待真实探测…</p> : null}
      </div>
    </Card>
  );
}

function EnvironmentTab({
  controller,
  projects,
  onRepair,
}: {
  controller: Controller;
  projects: Project[];
  onRepair: (action: string | null) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px]">
          <ProjectPicker
            label="当前项目（只影响下方的项目就绪探测）"
            placeholder="不选择项目"
            projects={projects}
            value={controller.readinessProjectId}
            onChange={controller.setReadinessProjectId}
          />
        </div>
        <Button variant="outline" icon={<RefreshCcw size={14} />} onClick={() => void controller.probe()} disabled={controller.busy}>重新探测</Button>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <CapabilityCard title="全局环境就绪" capabilities={controller.readiness?.global.capabilities} onRepair={onRepair} />
        <CapabilityCard title="当前项目就绪" capabilities={controller.readiness?.project?.capabilities} onRepair={onRepair} />
      </div>
      {controller.downloads.items.length ? (
        <Card title="下载进度">
          <div className="space-y-2">
            {controller.downloads.items.map((item) => (
              <div key={item.assetId} className={ROW}>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                  <span className="min-w-0 truncate">
                    {label(ASSET_LABELS, item.assetId)} · {label(DOWNLOAD_STAGE_LABELS, item.stage)}
                  </span>
                  <span className="shrink-0 text-[var(--color-text-muted)]">
                    <span className="tabular">{Math.round(item.progress * 100)}%</span> · {label(DOWNLOAD_STATUS_LABELS, item.status)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-[4px] bg-line">
                  <div className="h-full bg-gold" style={{ width: `${Math.round(item.progress * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function BackupTab({ controller, projects }: { controller: Controller; projects: Project[] }) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card
        title="备份与恢复"
        description="恢复前必须预览并确认；替换项目时会先生成安全归档。"
        actions={<RotateCcw size={15} className="text-gold-dark" />}
      >
        <div className="space-y-2.5">
          <ProjectPicker
            label="项目备份目标（只用于备份，不触发能力探测）"
            placeholder="请选择项目"
            projects={projects}
            value={controller.backupProjectId}
            onChange={controller.setBackupProjectId}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="secondary" onClick={() => void controller.createAppBackup()} disabled={controller.busy}>备份应用设置与资源</Button>
            <Button variant="outline" onClick={() => void controller.restore("app")} disabled={controller.busy}>恢复应用备份</Button>
            <Button
              variant="secondary"
              onClick={() => void controller.createProjectBackup()}
              disabled={controller.busy || !controller.backupProjectId}
              title={controller.backupProjectId ? undefined : "请先在上方选择要备份的项目"}
            >备份所选项目</Button>
            <Button variant="outline" onClick={() => void controller.restore("project")} disabled={controller.busy}>恢复项目备份</Button>
          </div>
        </div>
      </Card>
      <Card
        title="脱敏诊断包"
        description="必须先预览，再由你选择导出位置。"
        actions={<Database size={15} className="text-gold-dark" />}
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void controller.previewDiagnostics()} disabled={controller.busy}>生成预览</Button>
          <Button
            variant="primary"
            onClick={() => void controller.exportDiagnostics()}
            disabled={controller.busy || !controller.diagnostics}
            title={controller.diagnostics ? undefined : "请先生成预览并确认内容"}
          >确认并导出</Button>
        </div>
        {controller.diagnostics ? (
          <div className="mt-3 space-y-2">
            {controller.diagnostics.entries.map((entry) => (
              <details key={entry.name} className={ROW}>
                <summary className="cursor-pointer text-[12.5px] font-medium">{entry.name}</summary>
                <pre className="break-any mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11.5px] leading-5 text-[var(--color-text-muted)]">{entry.content}</pre>
              </details>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function AboutTab({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  const desktop = isDesktopRuntime();

  return (
    <Card title="关于项目" actions={<Info size={15} className="text-gold-dark" />}>
      <div className="space-y-2">
        <p className="text-[12.5px] leading-5 text-[var(--color-text-muted)]">
          AI 字幕本地化工作台 · 本地项目、可验证翻译、校对与导出。
        </p>
        <div className={`${ROW} flex items-center justify-between gap-3 text-[12.5px]`}>
          <span>运行环境</span>
          <Badge tone={desktop ? "green" : "gray"}>{desktop ? "桌面应用" : "浏览器预览"}</Badge>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 text-[11.5px] leading-5 text-[var(--color-text-muted)]">
            应用版本、平台与架构记录在脱敏诊断包的 manifest.json 条目里，可在「诊断与备份」中预览后再决定是否导出。
          </p>
          <Button variant="secondary" size="sm" onClick={onOpenDiagnostics}>前往诊断与备份</Button>
        </div>
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const { projects } = useWorkspace();
  const controller = useSettingsController(projects);
  const [tab, setTab] = useState("通用设置");
  const activeProjects = projects.filter((project) => !project.trashedAt);
  const showActionBar = FORM_TABS.includes(tab);

  const repair = (action: string | null) => {
    if (["open_provider", "open_model_manager"].includes(action ?? "")) return navigate("/capabilities");
    if (["open_project", "open_projects"].includes(action ?? "")) return navigate("/workspace");
    if (controller.readinessProjectId && ["open_project_settings", "relink_media", "open_editor"].includes(action ?? "")) {
      return navigate(`/projects/${controller.readinessProjectId}`);
    }
    void controller.probe();
  };

  const tabPanels: Record<string, ReactNode> = {
    通用设置: <GeneralTab />,
    文件管理: <FilesTab controller={controller} />,
    网络与凭据: <NetworkTab controller={controller} onOpenCredentials={() => navigate("/capabilities")} />,
    环境能力: <EnvironmentTab controller={controller} projects={activeProjects} onRepair={repair} />,
    诊断与备份: <BackupTab controller={controller} projects={activeProjects} />,
    关于: <AboutTab onOpenDiagnostics={() => setTab("诊断与备份")} />,
  };

  return (
    <>
      <PageHeader
        title="设置与能力中心"
        description="所有状态来自桌面端真实探测；不可用能力保留原因和修复入口。"
        actions={<Tabs items={TABS} value={tab} onChange={setTab} />}
      />
      <StatusBar message={controller.message} />
      {tabPanels[tab]}

      {showActionBar ? (
        <BottomActionBar>
          {controller.dirty ? (
            <span className="flex items-center gap-1.5 text-[11.5px] text-gold-dark">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
              有未保存修改
            </span>
          ) : null}
          <Button variant="dark" icon={<RefreshCcw size={15} />} onClick={() => void controller.reset()} disabled={controller.busy || !controller.settings}>恢复默认设置</Button>
          <Button
            variant="primary"
            icon={<Save size={15} />}
            onClick={() => void controller.save()}
            disabled={controller.busy || !controller.settings || !controller.dirty}
            title={controller.dirty ? undefined : "当前没有需要保存的修改"}
          >保存设置</Button>
        </BottomActionBar>
      ) : null}
    </>
  );
}
