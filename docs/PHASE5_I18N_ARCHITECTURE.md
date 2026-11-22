# PHASE 5 — Internationalization Architecture

## 1. Stack

**i18next v25 + react-i18next v16** (added to `dependencies`). Chosen over FormatJS/intl-messageformat because it fits the existing React/Vite stack without a build-time extraction step, supports namespaces, plural rules via `Intl.PluralRules`, interpolation, and on-demand resource loading out of the box.

## 2. Resource layout

```
src/locales/
  en-US/ common.json navigation.json workstation.json projects.json
         environment.json agent.json automation.json tasks.json
         git.json build.json release.json settings.json
         notifications.json errors.json
  zh-CN/ … (same 14 namespaces)
  zh-TW/ ja-JP/ ko-KR/ fr-FR/ de-DE/ es-ES/ pt-BR/ ru-RU/ …
```

- All languages share one key tree; nothing else in the renderer keeps its own dictionary.
- `en-US` is the fallback and ships inside the initial bundle.
- The other nine languages load **on demand**: `import.meta.glob('../locales/*/*.json', { exclude en-US })` produces one lazy chunk per namespace file; `ensureLanguageResources(code)` loads all namespaces of a language once, registers them via `addResourceBundle`, then `changeLanguage` runs — so a switch is atomic (no mixed-language frame).
- Dev mode enables `saveMissing`: unresolved keys print `[i18n] missing key "ns:key"` to the console instead of silently rendering the key path.

## 3. Core modules

| Module | Responsibility |
| --- | --- |
| `src/i18n/languages.ts` | Language registry (BCP 47 codes + native names), `resolveLanguage()` locale-tag matching (script subtags `zh-Hans/zh-Hant`, region casing, base-language fallback) — pure and unit tested |
| `src/i18n/config.ts` | i18next init, eager en-US resources, lazy loaders, `NAMESPACES` |
| `src/i18n/format.ts` | The only date/time/number/currency/byte/relative-time formatters (`Intl.*` with the active locale) |
| `src/i18n/settings.tsx` | `SettingsProvider`: startup preferences load, first-launch detection, theme resolution, persistence via bridge or localStorage |

## 4. Startup language resolution

```
saved preference valid?  ── yes ─► use it            (user choice always wins)
        │ no (first launch / corrupted value)
        ▼
systemLocale = app.getLocale()          (Electron main, passed via IPC)
        ▼
resolveLanguage(systemLocale)           (zh-Hans-CN → zh-CN, de → de-DE, xx → en-US)
```

The user's manual selection is never overwritten on later launches. Invalid codes fall back safely to `en-US`.

## 5. Persistence

Preferences live in `desktop-settings.json` inside the Windows user data directory (`%LOCALAPPDATA%\PROJECT NEXUS\desktop-settings.json`) — deliberately separate from project data (`state.json`) and never inside the installation/source directory.

Schema: `{ autoStart, language, theme, reduceMotion, agentReplyLanguage }`. The Electron main process owns the file; the renderer reads/writes through the frozen preload bridge (`desktop:settings:get`, `desktop:settings:update`). The main process validates every field (whitelisted language codes, theme values, boolean types) and writes atomically via the existing temp-file + rename routine. Corrupt or missing files fall back to defaults. In browser dev mode (no bridge) the same shape persists in `localStorage`.

## 6. What gets translated — and what deliberately does not

| Content | Treatment |
| --- | --- |
| Static UI (nav, headings, buttons, tables, dialogs, tooltips, empty states, toasts, settings) | `t()` with namespace keys |
| Application-generated activity/status lines | Stored as **keys + params** (`labelKey`/`detailKey`/`detailParams`), so history re-renders in the new language after a switch |
| Agent task statuses (`Queued`, `Running`, …) | Closed enum → `agent:status.*` keys |
| Agent event lines | Known `type` values → `agent:events.*` keys with `{{from}}/{{to}}` params; unknown types render the raw `detail` |
| GitHub/API enum values | `common:status.*` dictionary with `defaultValue` fallback to the raw value |
| AI model answers, provider rationale, prompts, code, diffs, terminal output, file paths | **Never translated** — rendered as-is |
| Error messages from the local service | Raw message text shown inside a translated label context (the message itself is system output) |

Native dialogs are localized by passing display strings from the renderer at call time (`projects:dialogs.*`); the main process validates but does not translate, keeping locale logic in one place. The tray menu uses a small per-language table in `desktop/main.mjs` applied at startup (tray text cannot follow runtime switches; it honors the saved language on the next launch).

## 7. Plurals, dates, numbers

- Plural keys use i18next JSON v4 suffixes (`_one`/`_other`); ru-RU additionally carries `_few`/`_many` per CLDR. The parity test enforces this.
- All formatting goes through `format.ts`: dates (`2026年11月13日` / `Nov 13, 2026` / `13. Nov. 2026`), times, relative times (`Intl.RelativeTimeFormat`), grouped numbers, token counts, byte sizes (KiB), and USD costs (currency fixed to USD, separators localized, up to 4 fraction digits).
- Fonts carry CJK fallbacks and no component hard-codes text widths that break with German/Russian string lengths; buttons and labels use flexible widths with ellipsis only where raw data (paths) is shown.

## 8. Agent reply language

Settings → AI Agent → "Agent reply language": **follow interface language / follow request language / fixed language**. When a task is submitted, the renderer appends a single transparent instruction line (visible in the task's REQUEST view): *"Please write your explanations in {{language}}. Keep all code, commands, identifiers and file paths unchanged."* — `agent:replyLanguage.instruction`. It never rewrites the user's own text and cannot affect code, commands or tool parameters.

## 9. Coverage & testing

- `scripts/i18n-coverage.mjs` → `docs/PHASE5_TRANSLATION_COVERAGE.md` (per-language key coverage vs en-US; `--strict` fails below 100%).
- `tests/unit/i18n-resources.test.mjs` — key parity, placeholder parity, no empty values, ru plural variants.
- `tests/unit/i18n-keys.test.mjs` — every literal/dynamic `t()` key in the sources exists in en-US; every component using `t()` imports `useTranslation`.
- `tests/unit/language-detection.test.mjs` — locale matching matrix.
- `tests/unit/i18n-format.test.mjs` — date/number/currency/relative formatting per locale.
- `tests/desktop-i18n.mjs` — real Electron acceptance: detection, zh-CN/ja-JP/en-US switching, instant UI update, settings-file persistence, restart restoration, theme flip, command palette.

## 10. Adding a language

1. Copy `src/locales/en-US/` to `src/locales/<tag>/` and translate the 14 files (keep keys/placeholders; add `_few/_many` if the language's CLDR plural set requires them).
2. Add the code to `LANGUAGES` in `src/i18n/languages.ts` and `SUPPORTED_LANGUAGES` in `desktop/main.mjs` (and to the tray string table if desired).
3. Run `npm run i18n:coverage` and `npm test`; the parity tests block incomplete sets.

RTL readiness: CSS uses logical properties throughout; adding an RTL language later requires a `dir` attribute on `<html>` plus a visual pass, not a stylesheet rewrite.
