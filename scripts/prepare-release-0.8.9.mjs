// One-shot release prep for v0.8.9 (2026-11-15) — atomic version: every anchor
// is validated BEFORE any file is written, so a mid-run failure can no longer
// leave a half-patched tree or a missing release-notes file (v0.8.8 lesson).
// Run: node scripts/prepare-release-0.8.9.mjs
import fs from 'node:fs'
import path from 'node:path'

const V = '0.8.9'
const PREV = '0.8.8'
const DATE = '2026-11-15'
const TITLE = 'ZIP 基线三方比较与 Agent 适配器'
const read = (file) => fs.readFileSync(file, 'utf8')

const writes = []

// ---- Validate every anchor first -----------------------------------------
function expectAnchor(file, needle) {
  const text = read(file)
  if (!text.includes(needle)) throw new Error(`${file}: anchor missing -> ${JSON.stringify(needle.slice(0, 120))}`)
  return text
}

const packageText = expectAnchor('package.json', `"version": "${PREV}"`)
const lockText = expectAnchor('package-lock.json', `"version": "${PREV}"`)
if ((lockText.match(new RegExp(`"version": "${PREV}"`, 'g')) || []).length !== 2) throw new Error('package-lock.json: expected exactly 2 version fields')

const historyFile = 'src/desktop/release-history.ts'
const historyText = expectAnchor(historyFile, `const bundledVersions = ['${PREV}',`)
expectAnchor(historyFile, `date: version === '${PREV}' ? '${DATE}' :`)

const testFile = 'tests/app-update-ui.mjs'
const testText = expectAnchor(testFile, `'${PREV}', '0.8.7'`)

const entries = {
  'en-US': {
    title: 'ZIP baseline three-way diff and agent adapters',
    summary: 'The upstream profile gains a ZIP baseline: capture the upstream file manifest once, then classify every path across baseline, your repository and the upstream latest state — conflicts, portable upstream changes and your own edits — without downloading file contents. Local AI coding tools now integrate through a unified adapter registry, and a new desktop assist channel detects the installed Codex desktop app, can start it and reveal task workspaces in Explorer.'
  },
  'zh-CN': {
    title: 'ZIP 基线三方比较与 Agent 适配器',
    summary: '上游档案新增 ZIP 基线：建立基线后对「基线、你的仓库、上游最新」逐文件分类，识别冲突、上游可移植变更与你的改动，全程不下载文件内容。本机 AI 编程工具改为统一适配器接入，并新增桌面辅助通道：检测已安装的 Codex 桌面端、可一键启动并在资源管理器中定位任务工作区。'
  },
  'zh-TW': {
    title: 'ZIP 基線三方比較與 Agent 适配器',
    summary: '上游檔案新增 ZIP 基線：建立基線後對「基線、你的儲存庫、上游最新」逐檔案分類，識別衝突、上游可移植變更與你的改動，全程不下載檔案內容。本機 AI 編程工具改為統一适配器接入，並新增桌面輔助通道：偵測已安裝的 Codex 桌面端、可一鍵啟動並在檔案總管中定位工作區。'
  },
  'ja-JP': {
    title: 'ZIP ベースライン三方比較と Agent アダプター',
    summary: '上流プロファイルに ZIP ベースラインを追加：作成後、「ベースライン・あなたのリポジトリ・上流の最新」をファイル単位で分類し、衝突・上流の移植可能な変更・あなたの変更を識別します。ファイル内容はダウンロードしません。ローカル AI コーディングツールは統一アダプターで接入し、デスクトップ補助チャネルでインストール済みの Codex デスクトップを検出・起動し、ワークスペースをエクスプローラーで表示できます。'
  },
  'ko-KR': {
    title: 'ZIP 베이스라인 삼방 비교와 Agent 어댑터',
    summary: '업스트림 프로필에 ZIP 베이스라인 추가: 생성 후 "베이스라인·내 저장소·업스트림 최신"을 파일별로 분류하여 충돌, 이식 가능한 업스트림 변경, 내 변경을 식별합니다. 파일 내용은 다운로드하지 않습니다. 로컬 AI 코딩 도구는 통합 어댑터로 연결되며, 데스크톱 보조 채널로 설치된 Codex 데스크톱을 감지·실행하고 탐색기에서 작업 공간을 표시할 수 있습니다.'
  },
  'de-DE': {
    title: 'ZIP-Baseline dreiseitiger Vergleich und Agent-Adapter',
    summary: 'Das Upstream-Profil erhält eine ZIP-Baseline: Nach der Erfassung wird jeder Pfad über Baseline, Ihr Repository und den Upstream-Neustand klassifiziert — Konflikte, portierbare Upstream-Änderungen und Ihre eigenen Bearbeitungen — ohne Dateiinhalte herunterzuladen. Lokale KI-Tools integrieren sich über eine einheitliche Adapter-Registrierung; ein Desktop-Assistenzkanal erkennt die installierte Codex-Desktop-App, kann sie starten und Arbeitsbereiche im Explorer anzeigen.'
  },
  'es-ES': {
    title: 'Diff de tres vías de la línea base ZIP y adaptadores de agente',
    summary: 'El perfil de procedencia incorpora una línea base ZIP: tras capturarla, cada ruta se clasifica entre línea base, tu repositorio y el upstream más reciente — conflictos, cambios portables del upstream y tus propias ediciones — sin descargar contenido. Las herramientas locales de IA se integran mediante un registro unificado de adaptadores, y un nuevo canal de asistencia de escritorio detecta la aplicación Codex instalada, puede iniciarla y abrir espacios de trabajo en el explorador.'
  },
  'fr-FR': {
    title: 'Diff à trois volets de la base ZIP et adaptateurs d’agent',
    summary: 'Le profil amont gagne une base de référence ZIP : après capture, chaque chemin est classé entre la base, votre dépôt et le dernier état amont — conflits, changements amont transférables et vos propres modifications — sans télécharger de contenu. Les outils locaux d’IA s’intègrent via un registre d’adaptateurs unifié, et un nouveau canal d’assistance bureau détecte l’application Codex installée, peut la lancer et afficher les espaces de travail dans l’Explorateur.'
  },
  'pt-BR': {
    title: 'Diff de três vias da linha de base ZIP e adaptadores de agente',
    summary: 'O perfil de procedência ganha uma linha de base ZIP: após capturá-la, cada caminho é classificado entre linha de base, seu repositório e o upstream mais recente — conflitos, mudanças portáveis do upstream e suas próprias edições — sem baixar conteúdo. As ferramentas locais de IA passam a se integrar por um registro unificado de adaptadores, e um novo canal de assistência de desktop detecta o aplicativo Codex instalado, pode iniciá-lo e abrir espaços de trabalho no Explorador.'
  },
  'ru-RU': {
    title: 'Трёхстороннее сравнение базовой линии ZIP и адаптеры агентов',
    summary: 'В профиль источника добавлена базовая линия ZIP: после захвата каждый путь классифицируется между базой, вашим репозиторием и последним состоянием источника — конфликты, переносимые изменения источника и ваши правки — без скачивания содержимого. Локальные ИИ-инструменты подключаются через единый реестр адаптеров, а новый канал вспомогательного рабочего стола обнаруживает установленное приложение Codex, может запустить его и показать рабочие области в Проводнике.'
  }
}
for (const locale of Object.keys(entries)) {
  const file = path.join('src/locales', locale, 'settings.json')
  const data = JSON.parse(read(file))
  if (data.appUpdate?.history?.releases?.v0_8_9) throw new Error(`${file}: v0_8_9 already present`)
  if (!data.appUpdate?.history?.releases?.v0_8_8) throw new Error(`${file}: v0_8_8 anchor missing`)
  writes.push({
    file,
    run: () => {
      const fresh = JSON.parse(read(file))
      const releases = fresh.appUpdate.history.releases
      const reordered = { v0_8_9: entries[locale] }
      for (const [key, value] of Object.entries(releases)) reordered[key] = value
      fresh.appUpdate.history.releases = reordered
      write(`${JSON.stringify(fresh, null, 2)}\n`)
    }
  })
}

const changelogText = expectAnchor('CHANGELOG.md', `| v${PREV} | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) |`)
const notesText = expectAnchor('docs/releases/release-notes.md', `| [v${PREV}](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [更新、下载与校验](v${PREV}.md) |`)
const readmeText = expectAnchor('README.md', `> **发布状态（如实说明）**：v${PREV} 为 Windows x64 开发预览`)
const autoUpdateText = expectAnchor('docs/APP_AUTO_UPDATE.md', `${DATE}：v${PREV} 发布（本机 Codex 桥接与仓库来源档案）。`)
const websiteText = expectAnchor('website/index.html', PREV)

// ---- All anchors valid: queue the remaining writes ------------------------
writes.push(
  {
    file: 'package.json',
    run: () => write(packageText.replaceAll(`"version": "${PREV}"`, `"version": "${V}"`))
  },
  {
    file: 'package-lock.json',
    run: () => write(lockText.replaceAll(`"version": "${PREV}"`, `"version": "${V}"`))
  },
  {
    file: historyFile,
    run: () => write(historyText
      .replace(`const bundledVersions = ['${PREV}',`, `const bundledVersions = ['${V}', '${PREV}',`)
      .replace(`date: version === '${PREV}' ? '${DATE}' :`, `date: version === '${V}' || version === '${PREV}' ? '${DATE}' :`))
  },
  {
    file: testFile,
    run: () => write(testText.replaceAll(`'${PREV}', '0.8.7'`, `'${V}', '${PREV}', '0.8.7'`))
  },
  {
    file: 'CHANGELOG.md',
    run: () => write(changelogText.replace(
      `| v${PREV} | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) |`,
      `| v${V} | ${DATE} | ${TITLE} | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${V}) |\n| v${PREV} | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) |`
    ))
  },
  {
    file: 'docs/releases/release-notes.md',
    run: () => {
      let text = notesText
        .replace(
          `| [v${PREV}](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [更新、下载与校验](v${PREV}.md) |`,
          `| [v${V}](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${V}) | ${DATE} | ${TITLE} | [更新、下载与校验](v${V}.md) |\n| [v${PREV}](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [更新、下载与校验](v${PREV}.md) |`
        )
        .replace(`> **发布状态（如实说明）**：v${PREV} 为 Windows x64 开发预览`, `> **发布状态（如实说明）**：v${V} 为 Windows x64 开发预览`)
        .replace(
          `${DATE}：v${PREV} 发布（本机 Codex 桥接与仓库来源档案）。`,
          `${DATE}：v${V} 发布（${TITLE}）。现有 0.8.2 及更高安装版可在设置中检查并更新；当前下载、校验与范围见 [v${V}](v${V}.md)。\n\n${DATE}：v${PREV} 发布（本机 Codex 桥接与仓库来源档案）。`
        )
      write(text)
    }
  },
  {
    file: 'README.md',
    run: () => write(readmeText.replace(`> **发布状态（如实说明）**：v${PREV} 为 Windows x64 开发预览`, `> **发布状态（如实说明）**：v${V} 为 Windows x64 开发预览`))
  },
  {
    file: 'docs/APP_AUTO_UPDATE.md',
    run: () => write(autoUpdateText.replace(
      `${DATE}：v${PREV} 发布（本机 Codex 桥接与仓库来源档案）。`,
      `${DATE}：v${V} 发布（${TITLE}）。现有 0.8.2 及更高安装版可在设置中检查并更新；当前下载、校验与范围见 [v${V}](releases/v${V}.md)。\n\n${DATE}：v${PREV} 发布（本机 Codex 桥接与仓库来源档案）。`
    ))
  },
  {
    file: 'website/index.html',
    run: () => write(websiteText.split(PREV).join(V))
  }
)

// The release-notes file must exist before any tag is pushed (CI gate).
const notesBody = `# v0.8.9 · ${TITLE}

${DATE} · Windows x64 · 已发布开发预览 · GitHub Latest

## 更新内容

- **ZIP 基线与三方比较（构建中心 · 上游档案）**：为申报了上游的仓库建立基线（记录上游文件清单与内容哈希），随后一键运行三方比较——对「基线、你的仓库、上游最新」逐文件分类：冲突（双方都修改、双方各自新增、你删上游留、你改上游删）、上游可移植变更、上游删除、你的改动、已同步。全程通过内容哈希比对，不下载任何文件内容；文件树过大时如实标记并保留计数。
- **统一 Agent 适配器**：本机 AI 编程工具改为适配器接入（官方 Codex App Server 原生通道 + 桌面端辅助通道），每个适配器如实上报安装状态与能力矩阵，缺失的能力显示为缺失；后续接入其他工具无需改动核心。
- **桌面辅助通道**：检测本机已安装的 Codex 桌面端（名称、版本、安装位置、运行状态），支持一键启动，以及把任务工作区在资源管理器中定位打开。任务注入桌面窗口与窗口自动化明确不做，能力矩阵如实展示。
- 界面文案与更新日志支持现有十种语言。

## 边界（如实说明）

- 三方比较基于上游/用户仓库的当前 git 树；ZIP 重传项目需先在「上游档案」中申报上游并建立基线，比较才有基线可比。
- 桌面辅助通道仅辅助（启动与定位），不向桌面窗口注入任务；编码执行仍走官方 app-server 独立会话。
- 安装包仍未签名（SignPath 开源签名资格审核中），下载前请核对 SHA256 校验文件。

## 下载与校验

[Windows x64 安装包](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.8.9/PROJECT-NEXUS-0.8.9-win-x64-setup.exe) · [SHA256 校验文件](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.8.9/SHA256SUMS.txt) · [发布页面](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.9)

公开安装包由 Windows 发布流程生成，大小和摘要以 Release 资产及 \`SHA256SUMS.txt\` 为准。自动更新需要安装包、对应 blockmap 和 \`latest.yml\`；0.8.2 及更高安装版可在设置中点击「检查更新」直接升级。
`
writes.push({ file: 'docs/releases/v0.8.9.md', run: () => write(notesBody) })

// ---- Apply everything ------------------------------------------------------
let currentFile = null
function write(content) {
  fs.writeFileSync(currentFile, content, 'utf8')
}

for (const { file, run } of writes) {
  currentFile = file
  run()
  if (!fs.existsSync(file)) throw new Error(`${file} missing after write`)
}
currentFile = null

// Final self-check: the CI gate file exists and its heading matches the tag.
const notes = read('docs/releases/v0.8.9.md')
if (!notes.startsWith(`# v0.8.9 · `)) throw new Error('v0.8.9.md heading invalid')
console.log(`All v${V} release prep applied atomically; docs/releases/v0.8.9.md present.`)
