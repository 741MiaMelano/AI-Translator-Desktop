# Subtitle format compatibility matrix

Status: production support matrix for subtitle import, editing, and export.

| Format / concern | Support | Retain | Normalize | Degrade | Unsupported |
|---|---|---|---|---|---|
| SRT | Import, edit source layers, normalized export | Cue times, multi-line text, cue order | Stable renumbering, LF output, domain `HH:MM:SS,mmm` | Optional/abnormal indices rewritten on export | Full QA scoring |
| WebVTT | Import, edit plain cue text, normalized export | Raw asset bytes; cue identifiers/settings noted in warnings | Plain cues → Segment text/time | NOTE/STYLE/REGION not segments; settings/ids not fully editable | Full VTT style/region authoring |
| ASS | Import normalize, limited ASS export | Raw asset bytes; style names summarized | Dialogue → plain text Segments | Inline override tags removed from editable layer | Full ASS effect engine / inline tag editing |
| SSA | Import normalize only | Raw SSA bytes | Treat as ASS-like events; rich export is ASS | SSA-specific style model not re-authored | SSA as primary export format |
| UTF-8 / UTF-8 BOM | Auto detect + decode | BOM presence in probe only | Working text is decoded Unicode | BOM not re-emitted on normalized export | — |
| UTF-16LE / UTF-16BE | BOM or strong signature | Encoding in probe summary | Decode to Unicode working layer | Re-export normalized as UTF-8 | Silent mojibake continue |
| GBK / Shift-JIS | User-confirmed when ambiguous | Encoding choice in probe | Decode after confirmation | No auto-guess when both valid | Silent wrong-codepage import |
| Empty / >8 MiB / illegal times | Controlled failure | No project created on hard parse fail | — | — | Soft-ignore invalid files |

## Source text layers

| Layer | Behavior |
|---|---|
| original | Set once from import; never overwritten by editor autosave |
| normalized | Set from import normalization; not overwritten by manual edit |
| manual | User edits only; clear restores display to normalized/original |

## Export modes

| Mode | Output | Record |
|---|---|---|
| raw | Byte-identical copy of `artifacts/raw/source.*` | `export_kind=source`, target fields NULL |
| normalized SRT/VTT/ASS | Deterministic serializer subset | `export_kind=source`, target fields NULL |

Normalized VTT/ASS exports may degrade structures retained only in the raw asset; warnings are shown.
