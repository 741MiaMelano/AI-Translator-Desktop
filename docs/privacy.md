# Privacy and local-data handling

Desktop AI Translator is local-first and has no product account, analytics,
telemetry, advertising SDK or cloud project synchronization.

## Data kept locally

The application stores the following under the current Windows user's managed
application-data directories or user-selected directories:

- project metadata, subtitle text, edits, QA state and run snapshots;
- referenced or optionally copied source media and generated artifacts;
- application settings, task history, bounded logs and resource libraries;
- downloaded ASR models and runtimes;
- user-created application and project backups;
- encrypted Provider credentials.

Provider secrets are encrypted through Electron `safeStorage` backed by Windows
DPAPI. Project databases, settings, logs, diagnostic exports and renderer APIs
contain only non-secret credential references and status.

## When data leaves the computer

Data is transmitted only for an action that needs a network service:

- starting translation sends the selected subtitle text, bounded read-only
  context, resource hints and request parameters to the selected Provider;
- testing a Provider connection contacts its configured endpoint;
- installing the ASR model downloads the pinned file from the selected official,
  mirror or custom public HTTPS source;
- opening a source or license link launches the system browser.

Local ASR, media probing, subtitle extraction, editing, QA, export, burn-in,
backup and restore do not upload project content. A custom Provider or download
source is operated by its own owner and is subject to that service's privacy
terms.

## Logs and diagnostic packages

Structured logs are local, size-bounded and rotated. The diagnostic exporter
redacts secret-like fields, Bearer values, API-key patterns, local paths, URL
queries and subtitle/prompt/text bodies. It exports only after the user previews
the summary and chooses a destination through a native file dialog.

Redaction reduces accidental disclosure but is not a substitute for review.
Inspect every diagnostic package before sharing it.

## Retention and deletion

Project data remains until the user permanently empties the project recycle bin
or removes the application user-data directory. Normal uninstall intentionally
keeps user data. Model, cache and backup directories may be outside the default
user-data directory and must be removed separately when complete erasure is
required.

See [user-guide.md](./user-guide.md#uninstall) for backup, uninstall and complete
local-data removal steps.
