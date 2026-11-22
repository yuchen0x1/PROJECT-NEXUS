# PHASE 5 — Design System

Direction: **Premium Dark Developer Workstation** — professional, restrained, information-dense. Research references (VS Code, JetBrains IDEs, Linear, GitHub Desktop) informed the structure; no assets or code were copied.

## 1. Tokens

All visual decisions live in one file: `src/theme.css`. Both shells (workstation and remote console) consume the same tokens; no component defines its own palette.

### Background hierarchy (dark, default)

| Token | Value | Use |
| --- | --- | --- |
| `--nx-bg` | `#0f1216` | Window base |
| `--nx-bg-rail` | `#12161b` | Activity bar, right rail |
| `--nx-bg-titlebar` | `#10141a` | Top bar |
| `--nx-bg-panel` | `#151a20` | Panels, cards |
| `--nx-bg-raised` | `#1a2028` | Secondary buttons, popovers |
| `--nx-bg-inset` | `#0c0f13` | Inputs, code wells |
| `--nx-bg-hover` / `--nx-bg-active` | `#1c232c` / `#222b36` | Interactive states |

### Accent + status

`--nx-accent` `#4c8ddf` (dark) / `#2174c4` (light) — a restrained workbench blue used for primary actions, focus, and selection. Status colors: success `#4cc38a`, warning `#d9a954`, danger `#e2685c`, info `#5aa9e6`, each with a `*-soft` background variant. Neon glows from the previous design were removed entirely.

### Typography

- UI: `Segoe UI Variable Text → Segoe UI → Microsoft YaHei UI → Yu Gothic UI → Malgun Gothic` (CJK fallback chain for zh/ja/ko).
- Mono: `Cascadia Mono → Consolas` for paths, versions, counts, code.
- Scale: 9/10/11/12/13/15/18/22 px. Base 13px; page titles 22px.

### Metrics

- Radii: 3 / 5 / 7 px (`--nx-r-sm/md/lg`) — deliberately small, desktop-native.
- Spacing: 4–32 px scale. Icon sizes: 14/16/18. Control heights: 28–34 px.
- Motion: 120 ms (fast), 180 ms (base), 260 ms (panels). Killed by `prefers-reduced-motion` or the in-app "Reduce motion" setting (`data-motion="reduced"`).

## 2. Themes

`[data-theme="dark"]` (default) and `[data-theme="light"]` on `<html>`; `theme: "system"` follows Windows via `prefers-color-scheme` and updates live. `SettingsProvider` (`src/i18n/settings.tsx`) resolves the theme, writes `data-theme`, `data-motion`, `style.colorScheme` and `lang` on the document element, and persists the choice through the desktop bridge.

Light theme values are full first-class overrides (not an inverted dark); both themes keep WCAG-A-compatible text contrast on their surfaces (body text ≥ 4.5:1 on panel backgrounds).

## 3. Layout

```
┌──┬──────────────────────────────────────────────┐
│A │ Top bar: breadcrumb · command trigger · bell │
│c ├───────────────────────────────┬──────────────┤
│t │                               │  Right rail  │
│i │        Work area              │  activity /  │
│v │  (page content, scrolls)      │  agent state │
│  │                               │  (collapsible│
│b ├───────────────────────────────┴──────────────┤
│a │ Bottom drawer: activity log (drag-resizable) │
└──┴──────────────────────────────────────────────┘
```

- **Activity bar** (left): brand, Workspace group (Workbench, Projects, Environment, AI Agent), Management group (Remote console, Settings). Collapses to a 56 px icon rail; active item gets an inset accent bar.
- **Top bar**: breadcrumb, command-palette trigger with `Ctrl+K` hint, notification bell with unread badge, theme toggle, settings shortcut.
- **Right rail**: service status, selected project, live Agent task chip, recent activity. Hidden on the remote console and settings pages.
- **Bottom drawer**: application activity log; height is drag-resizable (120–420 px), collapsed by default.

Pages do not share a forced grid: the Workbench mixes a readiness banner + summary strip + two-column panel zone; Environment is a full-width inspector table; the Agent page is a compose/history/review workbench; Settings is a single centered column of sections.

## 4. Components

Shared primitives used across pages: `nx-panel` (bordered surface with header row), `nx-primary/secondary/row/icon/text` buttons, `nx-status-chip` (status with tone), `nx-switch`, `nx-segmented` control, `nx-alert`, `nx-note`, `nx-toast`, empty states with an action affordance. The remote console's existing class names were kept, but its palette variables now map onto the same tokens, so both shells switch themes together.

## 5. Interaction rules

- Every destructive or external-effect action keeps an explicit confirmation (native localized dialog for folder removal; disclosure checkbox for Agent tasks; `confirm=true` gates unchanged).
- Feedback: toasts for language/theme/settings changes and Agent task completion; inline alerts for errors; loading spinners on poll-driven refreshes.
- Keyboard: `Ctrl+K` command palette (pages, actions, projects, appearance, language); `Esc` closes palette/notifications. No conflicts with Windows or IME shortcuts.
- RTL readiness: layout uses logical properties (`border-inline-start`, `inset-inline-end`, `margin-inline`), so RTL locales need no mirrored stylesheet. First ship set is LTR-only.
