# Desktop AI Translator user guide

## Requirements

- Windows 10 or Windows 11, x64.
- A CPU with SSE4.2 support for the bundled whisper.cpp CPU runtime.
- Internet access only when downloading the ASR model or calling a configured
  translation Provider.
- Enough free space for projects and the optional multilingual Whisper small
  model. The verified model is 487,601,967 bytes before project artifacts.

Node.js, Python and CUDA are not required. Both the installer and portable
edition contain Electron, FFmpeg and the CPU ASR runtime. The ASR model is
downloaded separately so the application stays smaller and model provenance
can be verified independently.

## Portable start, install and verification

The easiest no-install path is to download the portable executable from the
latest official Release. `启动便携版-Start-Portable.bat` first checks a verified
official executable beside the script, then a local build under `release`, and
finally a verified official executable under the ignored `.portable` directory.
If none exists, it opens the latest Release page. It does not download files or
read or store GitHub credentials.

To download an executable manually:

1. Download `AI-Translator-Desktop.exe` and its matching `.sha256` file from
   the same GitHub Release.
2. In PowerShell, run:

   ```powershell
   Get-FileHash .\AI-Translator-Desktop.exe -Algorithm SHA256
   ```

3. Confirm that the result matches the published checksum.
4. Confirm that the download came from the official `741MiaMelano` GitHub
   repository. V1 is unsigned, so Windows shows **Unknown publisher** and may
   display a SmartScreen warning.
5. Only after the source and checksum match, run the portable executable. If
   SmartScreen appears, select **More info → Run anyway**. The portable edition
   does not install shortcuts, require setup, or need administrator rights.

Do not run a copy from another download source or one whose checksum does not
match. The current release has no Authenticode publisher identity.

## Quick start

1. Start **AI Translator Desktop** and open **系统 → Provider 与凭据**.
2. Select a backend-enabled Provider, enter the API key, save it,
   and run **测试真实连接**. The key is stored through Windows protected storage and
   is never shown again.
3. For video or audio transcription, open **系统 → 模型与运行时** and install
   the verified multilingual **small** model. CPU is the default supported
   device; CUDA is optional and requires its separately verified runtime.
4. Return to **工作台**, choose a file, and continue through the unified import:
   - subtitles: SRT, VTT, ASS or SSA;
   - media: MKV, MP4, MOV, WebM, WAV, MP3, M4A, AAC or FLAC.
5. Review the detected media/subtitle tracks and the draft project's source
   language, target languages, Provider, and model.
6. Start processing. Paid Provider calls always require an explicit start or
   retry action.
7. Open the project, review each target-language card, enter **字幕编辑**, fix
   hard QA errors, protect important human edits, and approve the target track.
8. Export the approved subtitle. Video soft-mux or burn-in is available only
   when the required source media is linked and FFmpeg readiness is green.

Projects are saved automatically under the current Windows user's application
data. Closing or restarting the application does not require a manual project
save.

## Projects, tasks and recovery

- **项目与任务 → 项目** shows one row per project and prioritizes actionable work.
- Use **选择项目** in either **项目** or the current **批量处理** view to start,
  continue, pause/stop or recycle several projects with the shared bottom bar.
- A checkpoint-capable translation shows pause/resume. Media, ASR and export
  work without a safe checkpoint shows stop instead.
- Interrupted or failed work never makes another paid call automatically.
  Review the error, then explicitly retry or resume from the last safe point.
- Importing the same source again asks whether to continue the existing project
  or create a separate copy.
- Deleting a project first moves it to the application recycle bin. Emptying
  that recycle bin is permanent.
- If referenced source media moves, relink it before extraction, preview,
  soft-mux or burn-in. Subtitle editing remains available when possible.

## Media tools

Open **媒体工具** from the main navigation to extract WAV audio,
extract embedded text subtitles, transcribe video/audio, or adjust subtitle
timing. Select an existing project to reuse its media and tracks, or choose a
new file to create a lightweight project through the normal import flow. Each
tool returns to the same project so translation can continue without copying
media or ASR workflows.

## Backup, restore and updates

Before every application update:

1. Open **系统 → 设置、备份与诊断 → 备份与诊断**.
2. Create an application backup for settings and global resources.
3. Select important projects and create project backups.
4. Keep the backups outside the project directories.
5. Download the new installer from the official GitHub Release and verify its
   SHA-256.
6. Run the installer over the existing installation, then open representative
   projects and confirm their tracks and exports.

Database migrations run automatically and transactionally. A newer database
is rejected by an older application. In-place schema downgrade is unsupported;
rollback means reinstalling the prior application version and restoring the
backup made before the upgrade.

## Troubleshooting

### Provider is not ready

- Confirm the selected Provider supports translation.
- Replace or save its credential under **系统 → Provider 与凭据**, then run **测试真实连接**.
- For a custom Provider, use a public HTTPS base URL without embedded
  credentials and enter the exact model ID expected by that endpoint.
- A timeout, rate limit or server error does not trigger an automatic paid
  retry. Retry only after confirming the Provider state.

### ASR is not ready

- Open **系统 → 模型与运行时** and check runtime, model and device separately.
- The CPU runtime is included, but the multilingual small model must show
  **ready**. Retry the verified download or manually import the exact pinned
  model file.
- Choose CPU if the optional CUDA runtime or compatible NVIDIA environment is
  unavailable. The application does not silently replace the requested device.

### Media extraction, preview or export fails

- Check FFmpeg readiness in the capability view.
- Relink missing source media and confirm the selected audio/subtitle stream.
- Bitmap subtitle streams cannot be extracted as editable text; use a text
  subtitle stream or ASR.
- A burn-in failure does not invalidate an already exported subtitle. Retry
  only the video post-processing step after fixing the reported cause.

### A task was interrupted

- Open **项目与任务 → 任务** and read the recorded stage and error.
- Resume or retry only through the visible confirmation action. Work restarts
  from the last safe checkpoint; it is never silently replayed at startup.

### Settings path is rejected

Cache, model and backup paths must already exist, be ordinary local directories
and be readable and writable. They cannot be symbolic links or reside inside
the managed projects directory. Model-path changes take effect after restart.

### Collect diagnostics

Open **系统 → 设置、备份与诊断 → 备份与诊断**, preview the diagnostic package, and export it only
after reviewing the redacted content. It contains runtime/capability summaries
and bounded logs, not credentials or subtitle bodies. See
[privacy.md](./privacy.md) for the exact data boundary.

## Uninstall

1. Back up any projects or settings you want to keep.
2. Close the application, including any background/tray instance.
3. Open **Windows Settings → Apps → Installed apps** and uninstall
   **AI Translator Desktop**.

Normal uninstall removes application files and shortcuts but deliberately keeps
projects, settings, model downloads, backups and logs. Reinstalling can reuse
that data.

For complete local-data removal, uninstall first, then remove the application's
user-data directory under `%APPDATA%\desktop-ai-translator-ui` and any custom
cache, model or backup directories configured in **系统设置**. Verify backups before
deleting these directories; this cannot be undone.
