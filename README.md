# Desktop AI Translator / 桌面 AI 翻译器

A local-first Windows desktop application for subtitle translation, media
transcription, editing, quality review, and export.

面向 Windows 的本地优先字幕翻译与媒体本地化桌面应用，支持转写、翻译、编辑、
质量检查和交付导出。

[中文说明](#中文说明) · [English Guide](#english-guide) ·
[Releases](https://github.com/741MiaMelano/AI-Translator-Desktop/releases)

> Current published version / 当前发布版本：`1.0.2-rc.7`
>
> Current source version / 当前源码版本：`1.0.2-rc.7`
>
> Platform / 平台：Windows 10/11 x64
>
> License / 许可证：MIT
>
> Signing / 签名：Unsigned open-source build / 无 Authenticode 签名

---

## 中文说明

### 项目简介

Desktop AI Translator 用一个本地项目管理字幕、媒体引用、翻译任务、人工修改、
QA 状态和导出记录。项目数据默认保存在当前 Windows 用户的应用数据目录中；
媒体探测、字幕编辑、本地 ASR、QA、导出和备份均在本机完成。

应用不会自动产生付费调用。只有用户明确开始翻译、连接测试或重试时，才会访问
已配置的 Provider。当前版本不包含账户系统、遥测、广告或云端项目同步。

### 主要功能

- 持久化本地项目、自动保存、回收站、备份与崩溃恢复。
- 导入和编辑 SRT、VTT、ASS、SSA 字幕。
- 探测 MKV、MP4、MOV、WebM、WAV、MP3、M4A、AAC、FLAC 媒体。
- 提取媒体中的文本字幕流。
- 使用随包 whisper.cpp CPU 运行时执行本地 ASR；模型单独校验下载。
- 可选使用 CUDA-only 的 Qwen3-ASR 0.6B / 1.7B Preview 与 ForcedAligner。
- 后端注册表中已启用的 Provider 翻译，包括 OpenAI 和自定义 OpenAI-compatible 服务。
- 多目标语言、术语/风格资源、翻译快照和候选结果。
- 人工编辑保护、撤销/重做、搜索替换、时间轴调整和选中片段重跑。
- 硬错误/警告 QA、人工批准和可追踪的导出状态。
- 导出字幕、视频软封装，以及通过内置受校验 FFmpeg 执行 ASS 烧录。
- 批量任务、持久化队列、取消、失败诊断和显式恢复。
- Windows protected storage 保存 Provider 凭据；界面不会重新显示密钥。

### 最快启动：免安装便携版

1. 打开本项目的最新 Release。
2. 分别下载 `AI-Translator-Desktop.exe` 和同名 `.sha256` 文件。
3. 按下方说明核对 SHA-256，然后双击 EXE；不需要安装、Node.js 或管理员权限。

仓库中的 [`启动便携版-Start-Portable.bat`](./启动便携版-Start-Portable.bat)
优先启动与脚本同目录且通过内置 SHA-256 校验的官方 EXE，其次启动
`release` 目录中的本地构建，最后检查 `.portable` 中的官方 EXE；找不到文件时
会打开最新 Release 页面。脚本不会下载文件，也不会读取或保存 GitHub 凭据。

“便携版”表示应用无需安装；项目、设置、模型和日志仍写入当前 Windows 用户的
应用数据目录，而不是 EXE 旁边。这样可以避免移动或更新 EXE 时丢失数据。

### 直接下载

也可以从[最新官方 Release](https://github.com/741MiaMelano/AI-Translator-Desktop/releases/latest)
直接下载：

- `AI-Translator-Desktop.exe`：单独下载、免安装、双击运行。
- `AI-Translator-Desktop.exe.sha256`：SHA-256 校验文件。

本项目采用无签名开源发布。Windows 会显示 **Unknown publisher**，并可能显示
SmartScreen。请只从 `741MiaMelano/AI-Translator-Desktop` 官方仓库下载，运行前
核对 SHA-256。不要运行来源不明或哈希不一致的副本。

### 第一次使用

1. 启动应用，进入 **系统 → Provider 与凭据**。
2. 选择后端标记为可用的 Provider，保存 API key 并执行 **测试真实连接**。
3. 如需视频/音频转写，进入 **系统 → 模型与运行时**，安装已固定哈希的 multilingual Whisper `small` 模型。
   CPU 是默认支持路径；CUDA 是可选运行时。
4. 回到 **工作台**，选择字幕、视频或音频文件。
5. 检查探测结果、源语言、目标语言、Provider 和模型。
6. 明确确认后开始处理。失败不会在启动时静默重试，也不会自动重新发起付费请求。
7. 在字幕编辑器中检查人工文本、QA 错误和警告，完成后批准目标轨。
8. 导出字幕，或在源媒体已连接且 FFmpeg 就绪时执行软封装/烧录。

完整操作、更新、备份、故障排查和卸载步骤见
[`docs/user-guide.md`](./docs/user-guide.md)。

### 数据、网络与隐私

- 项目、字幕、任务、日志和设置默认保存在本机。
- 本地 ASR、媒体处理、编辑、QA、导出、备份和恢复不会上传项目内容。
- 翻译时，仅将所选字幕文本、受限上下文和请求参数发送给用户选择的 Provider。
- Provider 凭据通过 Electron `safeStorage` 和 Windows DPAPI 加密保存。
- 只有 Provider 调用、连接测试、模型下载和打开外部帮助/许可证链接需要网络。
- 普通卸载保留用户项目和设置；彻底删除前请先备份。

详细边界见 [`docs/privacy.md`](./docs/privacy.md)。

### 支持格式

| 类型 | 格式 |
|---|---|
| 字幕导入 | SRT、VTT、ASS、SSA |
| 字幕导出 | SRT、VTT、ASS（标准化子集） |
| 视频 | MKV、MP4、MOV、WebM |
| 音频 | WAV、MP3、M4A、AAC、FLAC |
| 编码 | UTF-8、UTF-8 BOM、UTF-16LE/BE；GBK/Shift-JIS 歧义时人工确认 |

格式保留和降级规则见
[`docs/subtitle-compatibility-matrix.md`](./docs/subtitle-compatibility-matrix.md)。

### 当前限制

- 仅支持 Windows 10/11 x64。
- 位图字幕不包含 OCR，不能直接转换为可编辑文本。
- Whisper `small` 模型约 488 MB，不随应用打包，需要单独下载。
- CUDA 需要兼容 NVIDIA 环境和单独校验的可选运行时。
- 不包含自动更新、配音或云端项目同步。
- 不支持在已经迁移的数据库上原地降级；更新前应创建备份。
- 自定义 Provider 的费用、数据处理和可用性由对应服务提供者负责。

### 开发环境

要求：

- Node.js `24.x`
- Corepack
- `pnpm@11.10.0`
- Windows 本地 NTFS 目录

pnpm 使用目录链接组织依赖。VMware Shared Folders、部分网络盘和不完整的同步盘
可能无法正确解析这些链接；开发时请把仓库放在 `C:` 等本地 NTFS 路径。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
corepack pnpm run start:desktop
corepack pnpm run check
```

不要运行 `npm install`，也不要提交 `package-lock.json`。

构建命令：

```powershell
corepack pnpm run build
corepack pnpm run package:portable
corepack pnpm run package:installer
corepack pnpm run package:release
```

- `package:portable` 生成免安装 EXE 和 SHA-256。
- `package:installer` 生成 NSIS 安装包，执行安装/升级/启动/卸载 smoke。
- `package:release` 同时生成便携版和安装版。

### 项目结构

```text
backend/      本地服务、持久化、任务、Provider、媒体和 ASR
electron/     Electron main、preload、IPC 和桌面生命周期
src/frontend/ 新 React UI、九套皮肤、页面和前端偏好
src/          共享 renderer 状态、控制器、领域逻辑和合同
shared/       main/worker/renderer 共用的纯逻辑
migrations/   app.sqlite 与 project.sqlite 顺序迁移
resources/    受校验的 FFmpeg 运行时及许可证
scripts/      构建、打包和端到端验证脚本
tests/        单元、合同、安全、持久化和 Electron 测试
docs/         用户、隐私、格式、发布和第三方合规文档
build/        产品图标
```

### 参与开发

1. Fork 仓库并从 `main` 创建分支。
2. 保持变更范围单一，不提交媒体、凭据、本地数据库或生成目录。
3. 运行 `corepack pnpm run check`。
4. 涉及桌面流程时，再运行相关 E2E 或 `corepack pnpm run test:e2e`。
5. 提交 Pull Request，说明行为变化、验证命令和用户影响。

### 许可证

应用源码使用 [MIT License](./LICENSE)。Electron、FFmpeg、whisper.cpp、模型和
其他第三方组件仍适用各自许可证，详见
[`THIRD-PARTY-NOTICES.txt`](./THIRD-PARTY-NOTICES.txt) 及 `docs/third-party/`。

---

## English Guide

### Overview

Desktop AI Translator keeps subtitle text, media references, translation jobs,
human edits, QA state, and export records in durable local projects. Media
probing, subtitle editing, local ASR, QA, export, and backup run on the user's
computer.

The application never starts a paid request automatically. Network Provider
operations happen only after an explicit translate, connection-test, or retry
action. The current version has no product account, telemetry, advertising, or cloud
project synchronization.

### Features

- Durable local projects, autosave, recycle bin, backups, and crash recovery.
- SRT, VTT, ASS, and SSA subtitle import and editing.
- MKV, MP4, MOV, WebM, WAV, MP3, M4A, AAC, and FLAC probing.
- Embedded text-subtitle extraction.
- Local ASR through the bundled whisper.cpp CPU runtime and separately verified
  model downloads.
- Optional CUDA-only Qwen3-ASR 0.6B / 1.7B Preview with ForcedAligner.
- Translation through backend-enabled Providers, including OpenAI and custom
  OpenAI-compatible services.
- Multiple target languages, terminology/style resources,
  run snapshots, and candidate results.
- Protected human edits, undo/redo, search/replace, timeline changes, and
  selected-segment reruns.
- QA errors/warnings, explicit human approval, and traceable export state.
- Subtitle export, video soft mux, and ASS burn-in through verified FFmpeg.
- Durable batch tasks, cancellation, diagnostics, and explicit recovery.
- Provider credentials protected by Windows-backed secure storage.

### Fastest start: no-install portable edition

1. Open the latest official Release.
2. Download `AI-Translator-Desktop.exe` and its matching `.sha256` file.
3. Verify SHA-256 as described below, then double-click the EXE. No install,
   Node.js, or administrator access is required.

[`启动便携版-Start-Portable.bat`](./启动便携版-Start-Portable.bat) first launches
an official EXE beside the script after verifying its pinned SHA-256, then a
local build under `release`, and finally an official EXE under `.portable`. If
none exists, it opens the latest Release page. It does not download files or
read or store GitHub credentials.

Portable means no installation. Projects, settings, models, and logs still use
the current Windows user's application-data locations rather than the folder
beside the EXE, so moving or replacing the executable does not lose data.

### Direct downloads

The [latest official Release](https://github.com/741MiaMelano/AI-Translator-Desktop/releases/latest)
provides:

- `AI-Translator-Desktop.exe`: standalone, no-install executable.
- `AI-Translator-Desktop.exe.sha256`: SHA-256 checksum.

This is an unsigned open-source release. Windows reports **Unknown publisher**
and may display SmartScreen. Download only from the official
`741MiaMelano/AI-Translator-Desktop` repository and verify SHA-256 before
running any executable.

### First run

1. Open **System → Provider & Credentials**.
2. Select a backend-enabled Provider, save the API key, and run **Test Real Connection**.
3. For video/audio transcription, open **System → Models & Runtime** and install the pinned multilingual Whisper
   `small` model. CPU is supported by default; CUDA is optional.
4. Return to **Workbench** and choose subtitles, video, or audio.
5. Review the probe result, source language, target languages, Provider, and model.
6. Explicitly confirm processing. Failures are never silently replayed at
   startup and paid requests are never retried automatically.
7. Review human text and QA results in the subtitle editor, then approve the
   target track.
8. Export subtitles, or soft-mux/burn them into linked media when FFmpeg is
   ready.

See [`docs/user-guide.md`](./docs/user-guide.md) for detailed update, backup,
recovery, troubleshooting, and uninstall instructions.

### Data, network, and privacy

- Projects, subtitles, tasks, logs, and settings are local by default.
- Local ASR, media work, editing, QA, export, backup, and restore do not upload
  project content.
- Translation sends selected subtitle text, bounded context, and request
  parameters only to the Provider selected by the user.
- Provider credentials use Electron `safeStorage` backed by Windows DPAPI.
- Network access is limited to Provider operations, connection tests, model
  downloads, and explicitly opened help/license links.
- Normal uninstall keeps user projects and settings. Back up before complete
  removal.

See [`docs/privacy.md`](./docs/privacy.md) for the complete boundary.

### Supported formats

| Type | Formats |
|---|---|
| Subtitle import | SRT, VTT, ASS, SSA |
| Subtitle export | SRT, VTT, ASS (normalized subset) |
| Video | MKV, MP4, MOV, WebM |
| Audio | WAV, MP3, M4A, AAC, FLAC |
| Text encodings | UTF-8, UTF-8 BOM, UTF-16LE/BE; user confirmation for ambiguous GBK/Shift-JIS |

See the
[`subtitle compatibility matrix`](./docs/subtitle-compatibility-matrix.md) for
retention and degradation rules.

### Current limitations

- Windows 10/11 x64 only.
- Bitmap subtitles have no OCR path and cannot be imported as editable text.
- The approximately 488 MB Whisper `small` model is downloaded separately.
- CUDA requires a compatible NVIDIA environment and optional verified runtime.
- No automatic updater, dubbing, or cloud project sync.
- In-place database downgrade is unsupported; create backups before updates.
- Custom Provider cost, retention, and availability are controlled by that
  service's operator.

### Development

Requirements:

- Node.js `24.x`
- Corepack
- `pnpm@11.10.0`
- A local Windows NTFS directory

pnpm uses directory links for dependencies. VMware Shared Folders, some network
drives, and incomplete sync folders may not resolve those links correctly. Keep
the development checkout on a local NTFS path such as `C:`.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm run dev
corepack pnpm run start:desktop
corepack pnpm run check
```

Do not run `npm install` and do not commit `package-lock.json`.

Build commands:

```powershell
corepack pnpm run build
corepack pnpm run package:portable
corepack pnpm run package:installer
corepack pnpm run package:release
```

- `package:portable` creates the no-install EXE and SHA-256 file.
- `package:installer` creates the NSIS installer and runs install, upgrade,
  launch, and uninstall smoke checks.
- `package:release` creates both release forms.

### Repository layout

```text
backend/      Local services, persistence, tasks, Providers, media, and ASR
electron/     Electron main/preload, IPC, and desktop lifecycle
src/frontend/ New React UI, nine themes, pages, and frontend preferences
src/          Shared renderer state, controllers, domain logic, and contracts
shared/       Pure logic shared by main, worker, and renderer
migrations/   Ordered app.sqlite and project.sqlite migrations
resources/    Verified FFmpeg runtime and license material
scripts/      Build, packaging, and end-to-end verification
tests/        Unit, contract, security, persistence, and Electron tests
docs/         User, privacy, format, release, and third-party documentation
build/        Product icons
```

### Contributing

1. Fork the repository and branch from `main`.
2. Keep changes focused; do not commit media, credentials, local databases, or
   generated directories.
3. Run `corepack pnpm run check`.
4. For desktop workflow changes, run the relevant E2E command or
   `corepack pnpm run test:e2e`.
5. Open a pull request describing behavior, validation, and user impact.

### License

Application source is licensed under the [MIT License](./LICENSE). Electron,
FFmpeg, whisper.cpp, models, and other third-party components remain under
their own terms; see [`THIRD-PARTY-NOTICES.txt`](./THIRD-PARTY-NOTICES.txt) and
`docs/third-party/`.
