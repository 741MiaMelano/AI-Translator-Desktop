# Test fixtures

## Media

Do **not** commit user media, private subtitles, or audio content.

Automated tests generate short original samples at runtime with the verified
managed FFmpeg runtime (`resources/ffmpeg/win32-x64` or a verified temporary
staging tree):

- ~1s `lavfi` video (`color` / `testsrc`) and silent audio (`anullsrc`)
- optional non-sensitive SRT/VTT cues authored by the test
- multi-track Matroska mux for extract/recommendation scenarios
- WAV for native `<audio>` Range preview
- truncated corrupt copies and wrong extensions for fail-closed probe cases

Generation always goes through `resolveVerifiedArtifactPaths` + argv arrays
(`shell:false`). Renderer never receives ffmpeg argv or absolute media paths.
