---
name: Desktop AI Translator · Brass Instrument
description: A local-first translation workstation built as one calibrated graphite-and-brass machine.
colors:
  graphite-housing: "#1b1814"
  warm-canvas: "#ece6db"
  warm-paper: "#f8f4ec"
  raised-paper: "#f1eadf"
  control-bed: "#eee7dc"
  heading-ink: "#1f1b17"
  body-ink: "#312b24"
  muted-ink: "#71675b"
  engraved-rule: "#bdae9b"
  brushed-brass: "#a87835"
  dark-brass: "#875c25"
  success-green: "#39754f"
  warning-ochre: "#916018"
  danger-copper: "#8f4b24"
typography:
  display:
    fontFamily: "Microsoft YaHei UI, PingFang SC, sans-serif"
    fontSize: "27px"
    fontWeight: 670
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Microsoft YaHei UI, PingFang SC, Noto Sans SC, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  data:
    fontFamily: "Cascadia Mono, Consolas, monospace"
    fontSize: "10.5px"
    fontWeight: 700
    lineHeight: 1.5
rounded:
  control: "7px"
  panel: "11px"
  dock: "9px"
  pill: "999px"
spacing:
  "1": "5px"
  "2": "8px"
  "3": "13px"
  "4": "18px"
  "5": "24px"
  "6": "32px"
components:
  button-primary:
    backgroundColor: "{colors.brushed-brass}"
    textColor: "{colors.warm-paper}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "38px"
  button-secondary:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.body-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "38px"
  panel:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.body-ink}"
    rounded: "{rounded.panel}"
    padding: "18px"
---

# Final Design System: Desktop AI Translator · One Route, Nine Instruments

## Overview

**Creative North Star: "One Route, Nine Instruments"**

The default production master is Brass Instrument: a graphite machine housing warm paper work beds, brushed-brass controls, engraved rules, and measured readouts. It should feel like one trustworthy local apparatus rather than a generic dashboard. Real project and readiness state determine what appears; empty, blocked, and unavailable states retain the same material dignity as populated work.

The shared component tree is the durable skeleton for all nine production visual worlds. A–I are all selectable, persisted, and tested against the same business state. Their tokens, signature SVGs, procedural motion, selection/scrollbar treatment, and Web Audio recipes come from the corresponding approved prototype; none is a recolored Brass approximation.

**Key Characteristics:**

- One fixed desktop shell with a graphite rail, warm work surface, and native window controls.
- One dominant work surface per page; supporting facts remain quieter and denser.
- Brass is rare action metal, not a general background color.
- Readiness, blockers, empty data, and disabled actions are explicit and truthful.
- Data, counts, versions, and codes use a measured monospaced voice.
- Motion is short and tactile, with a complete reduced-motion fallback.
- Theme, sound, visual-effects, and reduced-motion preferences never replace or reset the active project tree.

## Production Theme Identities

| Code | Runtime id | Name | Prototype | Signature | Scheme |
|---|---|---|---|---|---|
| A | `brass` | 黄铜机台 | `A-brass.html` | concentric mechanism | light |
| B | `ticket` | 航线票夹 | `B-ticket.html` | route/perforation | light |
| C | `proof` | 套色校样 | `C-proof.html` | registration marks | light |
| D | `fold` | 折页星图 | `D-fold.html` | crease geometry | light |
| E | `strata` | 云层剖面 | `E-strata.html` | sonar section | light |
| F | `signal` | 信号母带 | `F-signal.html` | VU bus | dark |
| G | `celadon` | 青瓷刻度 | `G-celadon.html` | glaze ripple | light |
| H | `relay` | 工业信号 | `H-relay.html` | relay LED | dark |
| I | `inkwhite` | 墨白编校 | `I-inkwhite.html` | proof mark | light |

## Colors

Warm paper neutrals carry content, graphite encloses the machine, and brushed brass is reserved for the current route, focus, and decisive controls. Green, ochre, and copper remain semantic state colors and are never replaced by the accent merely to match the skin.

### Primary

- **Brushed Brass:** the scarce action metal for the primary lever, focus, active route, and calibrated highlights.
- **Dark Brass:** the hover/pressed companion that keeps primary controls tactile without introducing a second accent.

### Neutral

- **Graphite Housing:** the fixed rail and dark machine surfaces.
- **Warm Canvas:** the application field behind work surfaces.
- **Warm Paper:** the primary content stock for panels and docks.
- **Raised Paper and Control Bed:** closely related tonal steps for nested surfaces and controls.
- **Heading, Body, and Muted Ink:** a three-level information hierarchy with no low-contrast decorative copy.
- **Engraved Rule:** the stronger structural edge for controls, separators, and focus-adjacent geometry.

**The Rare Metal Rule.** Brass marks the current action or measurement. A screen must not become a brass-colored card collection.

**The Semantic State Rule.** Success, warning, and danger retain their own colors, labels, and non-color cues across every skin.

## Typography

**Display Font:** Microsoft YaHei UI with PingFang SC fallback.
**Body Font:** Microsoft YaHei UI with PingFang SC, Noto Sans SC, and Segoe UI fallbacks.
**Label/Mono Font:** Cascadia Mono with Consolas fallback.

**Character:** Display type is compact, sturdy, and highly readable in Chinese. The monospaced layer makes versions, counts, timings, and machine labels feel calibrated without becoming the primary reading voice.

### Hierarchy

- **Display** (670, 27px, 1.15): page theses and major work-surface titles.
- **Headline** (700, 22–25px, about 1.2): dominant intake and status declarations.
- **Title** (700, 15–16px, about 1.3): panel names and decision groups.
- **Body** (400, 14px, 1.55): instructions and project content; supporting text steps down to 12–13px.
- **Label/Data** (600–700, 9.5–11px, 1.5): counts, versions, codes, states, and compact metadata.

**The Human-First Rule.** Lead with the task or condition in plain Chinese; technical identifiers follow as supporting data.

## Layout

The default Brass shell uses a 218px rail, a 57px top bar, and a centered work stage capped at 1240px; each other theme may adjust those measurements through its approved tokens. The workbench uses a dominant intake platen beside a smaller local-project ledger. The subtitle editor exposes the active project's segment list, source/target editor, timeline tools, candidates, QA and inspector; when no target track exists, the shortcut returns to the real project ledger instead of manufacturing an editor state.

At 1320px the stage and secondary statistics tighten. At 1300px the rail becomes a 72px icon rail and the editor inspector becomes a 372px drawer. At 1100px workbench columns stack and the inspector narrows. The supported desktop minimum is 1280×720; a 1040px CSS safety floor prevents accidental collapse. Short windows gain vertical scrolling rather than horizontal clipping. Windows 200% scaling is tested by launching Electron with a device scale factor of 2, not by substituting page zoom.

Shared spacing follows a compact 5/8/13/18/24/32px rhythm. Persistent actions may sit in a bottom dock, while long system and ASR content scrolls progressively.

**The Shared Skeleton Rule.** Navigation, route order, editor regions, state language, and action placement remain common across all skins; only approved material tokens, geometry, type, and motion vary.

## Elevation & Depth

Brass Instrument uses tonal nesting plus restrained ambient shadows. Warm paper panels lift only enough to separate from the canvas; the dark intake platen is the strongest resting elevation; docks and overlays sit clearly above operational content.

### Shadow Vocabulary

- **Paper lift** (`0 3px 12px rgba(53,42,29,.055)`): ordinary content panels.
- **Platen lift** (`0 12px 31px rgba(42,33,22,.14)`): the dominant dark intake surface.
- **Control lift** (`0 3px 8px rgba(92,59,17,.18)`): primary brass controls at rest.
- **Dock lift** (`0 12px 35px rgba(44,34,23,.14)`): persistent action and recovery surfaces.

**The Material Truth Rule.** Depth must read as paper inside a graphite-and-brass instrument; do not introduce glass, neon glow, or generic floating SaaS cards.

## Shapes

Controls use measured 7px corners, panels use 11px corners, and persistent docks use 9px corners. Status tags may be pills, while stage points and mechanical orbits remain circular. Thin engraved borders and concentric instrument geometry carry identity; arbitrary over-rounding does not.

## Components

### Buttons

- **Shape:** 38px minimum height, 15px horizontal padding, and measured 7px corners.
- **Primary:** brass fill with warm high-contrast ink and a restrained lift; only one primary lever per decision region.
- **Secondary:** warm paper with a strong engraved rule; hover moves the rule toward brass.
- **Focus / Disabled:** a visible 2px brass outline with 3px offset; disabled controls stay visible at reduced opacity and never activate.

### Cards / Containers

- **Corner Style:** 11px for major paper panels; nested operational cells may be tighter.
- **Background:** warm paper over a warm canvas, with dark graphite reserved for machine/intake/media regions.
- **Shadow Strategy:** tonal hierarchy first, restrained ambient lift second.
- **Border:** one engraved warm rule; avoid stacks of unrelated cards.

### Navigation

The fixed rail uses 44px rows, inline SVG icons, plain-language labels, optional counts, and one narrow brass active marker. Below 1300px it becomes a 72px icon rail with accessible labels retained through `aria-label` and title text.

### Signature Intake Platen

The workbench focal surface is a dark calibrated platen with a theme-specific intake object, engraved inset rule, restrained watermark, and factual readiness below it. Its primary control opens the real unified import flow for subtitle, video, and audio files. Import probing, ambiguity resolution, plan confirmation, and project creation all cross the desktop backend; the surface never substitutes demo media or simulated readiness.

### Readiness and Empty States

Readiness cells expose the real backend condition, unavailable reason, and truthful recovery guidance. Empty projects and an unopened editor preserve structure with concise local-state copy; they never use synthetic rows, fake progress, fake hardware, or mock success.

### Sound and Motion

Interaction sounds use nine approved short procedural recipes selected by the active theme and a persistent user-controlled mute. Route, control, drawer, and toast motion generally resolves within 100–240ms; `prefers-reduced-motion` and the explicit preference collapse non-essential animation and transition timing. Visible state, focus, text labels and progress remain available without sound or motion.

## Verified Product Surfaces

The final route family is defined by `src/frontend/App.tsx`: workbench/import; project and task ledger; project overview/settings; media and local ASR; editor; QA/approval/delivery; batch review; resource library; Provider and credential maintenance; ASR model/runtime/device/VAD maintenance; application settings, storage, backup, diagnostics, and global tasks. Legacy route aliases only redirect to these surfaces and own no UI.

The design-system implementation is `src/frontend/theme.ts`, `src/frontend/visuals.tsx`, `src/frontend/sound-engine.mjs`, and `src/frontend/styles/{prototype,production}.css`. The archived migration evidence is intentionally excluded from the release repository; current behavior is protected by the frontend boundary tests and Electron E2E suite.

## Do's and Don'ts

### Do:

- Do let backend capability and local project state decide which controls and content exist.
- Do preserve the approved A-brass SVGs, material tokens, sounds, motion grammar, and responsive shell.
- Do keep focus, disabled reasons, empty states, and recovery paths visible.
- Do use monospaced type for versions, counts, timings, codes, and file facts.
- Do derive each later skin from its approved prototype world while keeping one shared semantic tree.

### Don't:

- Don't restore old UI components, layout logic, theme code, or information architecture.
- Don't ship a control whose visible promise has no real backend or local UI behavior.
- Don't fill production surfaces with prototype fixtures, fake hardware, invented project progress, or simulated success.
- Don't recolor Brass to approximate another skin or blend material languages across skins.
- Don't add glass, generic dashboard card grids, ornamental glow, or unapproved visual dependencies.
