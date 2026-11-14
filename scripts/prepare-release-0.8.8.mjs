// One-shot release prep for v0.8.8 (2026-11-15): bump version, bundled update
// history in 10 languages, changelog, release notes, website links.
// Run: node scripts/prepare-release-0.8.8.mjs
import fs from 'node:fs'
import path from 'node:path'

const V = '0.8.8'
const PREV = '0.8.7'
const DATE = '2026-11-15'
const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, content) => fs.writeFileSync(file, content)

// 1. package.json + package-lock.json
for (const file of ['package.json', 'package-lock.json']) {
  const text = read(file)
  if (!text.includes(`"version": "${PREV}"`)) throw new Error(`${file}: expected ${PREV} version`)
  write(file, text.replaceAll(`"version": "${PREV}"`, `"version": "${V}"`))
}
console.log('package.json / package-lock.json: bumped')

// 2. release-history.ts: bundled versions + date map
{
  const file = 'src/desktop/release-history.ts'
  let text = read(file)
  text = text.replace(`const bundledVersions = ['${PREV}',`, `const bundledVersions = ['${V}', '${PREV}',`)
  text = text.replace(
    "date: version === '0.8.7' || version === '0.8.6' ? '2026-11-14' : '2026-11-13'",
    "date: version === '0.8.8' ? '2026-11-15' : version === '0.8.7' || version === '0.8.6' ? '2026-11-14' : '2026-11-13'"
  )
  if (!text.includes(`'${V}', '${PREV}'`) || !text.includes("'2026-11-15'")) throw new Error('release-history.ts patch failed')
  write(file, text)
  console.log('release-history.ts: patched')
}

// 3. tests/app-update-ui.mjs assertion
{
  const file = 'tests/app-update-ui.mjs'
  const text = read(file)
  if (!text.includes(`'${PREV}', '0.8.6'`)) throw new Error('app-update-ui.mjs assertion anchor missing')
  write(file, text.replaceAll(`'${PREV}', '0.8.6'`, `'${V}', '${PREV}', '0.8.6'`))
  console.log('tests/app-update-ui.mjs: patched')
}

// 4. settings.json in 10 locales: v0_8_8 entry
const entries = {
  'en-US': {
    title: 'Local Codex bridge and repository origin profiles',
    summary: 'Tasks can be delegated to the local Codex through the official app-server interface: independent sessions write only inside an isolated workspace, stream live events and are independently accepted. Repositories also gain an origin profile with GitHub-verified forks, proven shared histories and explicit ZIP or third-party declarations. New update discoveries now raise a toast and a notification entry.'
  },
  'zh-CN': {
    title: '本机 Codex 桥接与仓库来源档案',
    summary: '新增通过官方 app-server 接口调度本机 Codex：独立会话仅写入隔离工作区，实时回传事件，完成后独立验收。仓库新增来源档案：自动识别 Fork 与共同提交历史，支持申报 ZIP 重传或第三方来源，结论附带证据与置信度。发现新版本时会在提醒中心弹出提示。'
  },
  'zh-TW': {
    title: '本機 Codex 橋接與儲存庫來源檔案',
    summary: '新增透過官方 app-server 介面調度本機 Codex：獨立工作階段僅寫入隔離工作區，即時回傳事件，完成後獨立驗收。儲存庫新增來源檔案：自動識別 Fork 與共同提交歷史，支援申報 ZIP 重傳或協力廠商來源，結論附帶證據與信心度。發現新版本時會在提醒中心彈出提示。'
  },
  'ja-JP': {
    title: 'ローカル Codex ブリッジとリポジトリ由来プロファイル',
    summary: '公式 app-server インターフェース経由でローカル Codex にタスクを委譲：独立セッションは隔離ワークスペース内のみに書き込み、イベントをリアルタイムに配信し、完了後に独立検証します。リポジトリには由来プロファイルも追加：GitHub で検証された Fork、証明された共通履歴、明示的な ZIP・サードパーティ申告に対応。新バージョン検出時はトーストと通知センターに表示されます。'
  },
  'ko-KR': {
    title: '로컬 Codex 브리지와 저장소 출처 프로필',
    summary: '공식 app-server 인터페이스를 통해 로컬 Codex에 작업을 위임합니다. 독립 세션은 격리된 작업 공간에만 기록하고 이벤트를 실시간 전달하며 완료 후 독립 검증을 거칩니다. 저장소에 출처 프로필이 추가되어 GitHub 검증 포크, 입증된 공통 이력, 명시적 ZIP·서드파티 신고를 지원합니다. 새 업데이트 발견 시 토스트와 알림 센터에 표시됩니다.'
  },
  'de-DE': {
    title: 'Lokale Codex-Brücke und Repository-Herkunftsprofile',
    summary: 'Aufgaben lassen sich über die offizielle App-Server-Schnittstelle an den lokalen Codex übergeben: unabhängige Sitzungen schreiben ausschließlich in einen isolierten Arbeitsbereich, streamen Ereignisse live und werden eigenständig abgenommen. Repositories erhalten ein Herkunftsprofil mit GitHub-verifizierten Forks, nachgewiesenen gemeinsamen Historien und expliziten ZIP- bzw. Drittanbieter-Deklarationen. Neue Update-Funde erscheinen zusätzlich als Toast und Benachrichtigung.'
  },
  'es-ES': {
    title: 'Puente Codex local y perfiles de procedencia',
    summary: 'Las tareas pueden delegarse en el Codex local mediante la interfaz oficial de app-server: sesiones independientes que solo escriben en un espacio de trabajo aislado, transmiten eventos en vivo y se aceptan de forma independiente. Los repositorios incorporan un perfil de procedencia con forks verificados por GitHub, historiales compartidos probados y declaraciones explícitas de ZIP o terceros. Los nuevos hallazgos de actualización muestran un toast y una entrada en el centro de notificaciones.'
  },
  'fr-FR': {
    title: 'Pont Codex local et profils d’origine des dépôts',
    summary: 'Les tâches peuvent être confiées au Codex local via l’interface officielle app-server : des sessions indépendantes n’écrivent que dans un espace de travail isolé, diffusent les événements en direct et font l’objet d’une acceptation indépendante. Les dépôts gagnent un profil d’origine avec forks vérifiés par GitHub, historiques partagés prouvés et déclarations explicites ZIP ou tierces. Les nouvelles découvertes de mise à jour déclenchent un toast et une entrée dans le centre de notifications.'
  },
  'pt-BR': {
    title: 'Ponte Codex local e perfis de procedência',
    summary: 'Tarefas podem ser delegadas ao Codex local pela interface oficial de app-server: sessões independentes escrevem apenas em um espaço de trabalho isolado, transmitem eventos em tempo real e passam por aceite independente. Os repositórios ganham um perfil de procedência com forks verificados pelo GitHub, históricos compartilhados comprovados e declarações explícitas de ZIP ou terceiros. Novas descobertas de atualização exibem toast e entrada na central de notificações.'
  },
  'ru-RU': {
    title: 'Локальный мост Codex и профили происхождения репозиториев',
    summary: 'Задачи можно передавать локальному Codex через официальный интерфейс app-server: независимые сессии пишут только в изолированную рабочую область, транслируют события в реальном времени и проходят независимую приёмку. Репозитории получают профиль происхождения: подтверждённые GitHub форки, доказанные общие истории и явные заявления о ZIP или стороннем происхождении. Обнаружение новой версии теперь сопровождается всплывающим уведомлением и записью в центре уведомлений.'
  }
}
for (const [locale, entry] of Object.entries(entries)) {
  const file = path.join('src/locales', locale, 'settings.json')
  const data = JSON.parse(read(file))
  const releases = data.appUpdate.history.releases
  if (releases[`v0_8_8`]) throw new Error(`${file}: v0_8_8 already present`)
  const reordered = { v0_8_8: entry }
  for (const [key, value] of Object.entries(releases)) reordered[key] = value
  data.appUpdate.history.releases = reordered
  write(file, `${JSON.stringify(data, null, 2)}\n`)
}
console.log('settings.json ×10: v0_8_8 entries added')

// 5. CHANGELOG.md + release-notes.md rows
{
  const file = 'CHANGELOG.md'
  const text = read(file)
  const anchor = `| v${PREV} | 2026-11-14 | 一键下载开发环境 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) |`
  if (!text.includes(anchor)) throw new Error('CHANGELOG.md anchor missing')
  write(file, text.replace(anchor, `| v${V} | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [已发布](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${V}) |\n${anchor}`))
  console.log('CHANGELOG.md: row added')
}
{
  const file = 'docs/releases/release-notes.md'
  let text = read(file)
  const anchor = `| [v${PREV}](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${PREV}) | 2026-11-14 | 一键下载开发环境 | [更新、下载与校验](${PREV}.md) |`
  if (!text.includes(anchor)) throw new Error('release-notes.md anchor missing')
  text = text.replace(anchor, `| [v${V}](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v${V}) | ${DATE} | 本机 Codex 桥接与仓库来源档案 | [更新、下载与校验](${V}.md) |\n${anchor}`)
  const statusAnchor = `> **发布状态（如实说明）**：v${PREV} 为 Windows x64 开发预览`
  if (text.includes(statusAnchor)) text = text.replace(statusAnchor, `> **发布状态（如实说明）**：v${V} 为 Windows x64 开发预览`)
  const datedAnchor = `2026-11-14：v${PREV} 发布（一键下载开发环境）。`
  if (text.includes(datedAnchor)) text = text.replace(datedAnchor, `${DATE}：v${V} 发布（本机 Codex 桥接与仓库来源档案）。现有 0.8.2 及更高安装版可在设置中检查并更新；当前下载、校验与范围见 [v${V}](${V}.md)。\n\n${datedAnchor}`)
  write(file, text)
  console.log('release-notes.md: updated')
}

// 6. v0.8.8 release notes (CI parses the H1 as the release title)
write('docs/releases/v0.8.8.md', `# v0.8.8 · 本机 Codex 桥接与仓库来源档案

${DATE} · Windows x64 · 已发布开发预览 · GitHub Latest

## 更新内容

- **本机 Codex 桥接（AI 智能体页）**：新增任务引擎选项「Codex 桥接」，通过 OpenAI 官方 \`codex app-server\` 接口把编码任务交给本机 Codex 执行。每个任务使用独立会话，Codex 只能写入 NEXUS 的隔离工作区（git worktree / 有界副本），命令与文件变更实时回传任务时间线；完成后由 NEXUS 独立验收（diff + 构建/测试），交付仍需人工确认。已打开的 Codex Desktop 窗口与历史会话不受影响；凭据完全沿用你自己的 Codex 登录，NEXUS 不读取、不复制登录凭据。
- **Codex 连接测试**：未检测到 Codex 时任务引擎选项自动禁用并给出安装提示（支持 winget 安装 OpenAI.Codex 或 NEXUS_CODEX_PATH 指定路径）；状态卡可发起真实连接测试（握手 + 账号状态 + 模型目录），成功结果缓存 60 秒。
- **仓库来源档案（构建中心）**：为每个仓库建立来源档案——Fork 关系以 GitHub 返回的 parent/source 为证据（置信度 1.0），共同提交历史以跨仓库 compare API 证明 merge-base（记录领先/落后提交数），ZIP 重传与第三方来源必须显式申报。候选上游绝不按仓库名自动绑定；申报后若核实出更强证据，档案自动升级且申报记录保留。项目列表卡片显示来源徽章。
- **更新发现提醒**：检查到新版本时，除应用内更新卡外新增右下角 toast 与通知中心条目（每个版本每次会话提醒一次）。
- 界面文案与更新日志支持现有十种语言。

## 边界（如实说明）

- 通过 app-server 创建的是独立 Codex 会话，官方接口不提供接管既有桌面窗口的能力；如需查看执行过程，可在 Codex Desktop 打开同一项目的工作区目录。
- 桥接任务消耗你自身 Codex 账户额度；审批类请求在桥接会话中一律自动拒绝，因此不会执行需要提权的命令。
- 安装包仍未签名（SignPath 开源签名资格审核中），下载前请核对 SHA256 校验文件。

## 下载与校验

[Windows x64 安装包](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.8.8/PROJECT-NEXUS-0.8.8-win-x64-setup.exe) · [SHA256 校验文件](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/download/v0.8.8/SHA256SUMS.txt) · [发布页面](https://github.com/yuchen0x1/PROJECT-NEXUS/releases/tag/v0.8.8)

公开安装包由 Windows 发布流程生成，大小和摘要以 Release 资产及 \`SHA256SUMS.txt\` 为准。自动更新需要安装包、对应 blockmap 和 \`latest.yml\`；0.8.2 及更高安装版可在设置中点击「检查更新」直接升级。
`)
console.log('docs/releases/v0.8.8.md: created')

// 7. README status line
{
  const file = 'README.md'
  const text = read(file)
  const anchor = `> **发布状态（如实说明）**：v${PREV} 为 Windows x64 开发预览`
  if (!text.includes(anchor)) throw new Error('README.md anchor missing')
  write(file, text.replace(anchor, `> **发布状态（如实说明）**：v${V} 为 Windows x64 开发预览`))
  console.log('README.md: status line updated')
}

// 8. APP_AUTO_UPDATE.md history line
{
  const file = 'docs/APP_AUTO_UPDATE.md'
  const text = read(file)
  const anchor = `${DATE.replace('2026-11-15', '2026-11-14')}：v${PREV} 发布（一键下载开发环境）。`
  if (!text.includes(anchor)) throw new Error('APP_AUTO_UPDATE.md anchor missing')
  write(file, text.replace(anchor, `${DATE}：v${V} 发布（本机 Codex 桥接与仓库来源档案）。现有 0.8.2 及更高安装版可在设置中检查并更新；当前下载、校验与范围见 [v${V}](releases/v${V}.md)。\n\n${anchor}`))
  console.log('APP_AUTO_UPDATE.md: history line added')
}

// 9. website/index.html links
{
  const file = 'website/index.html'
  const text = read(file)
  if (!text.includes('0.8.7')) throw new Error('website/index.html: no 0.8.7 references')
  write(file, text.replaceAll('0.8.7', V))
  console.log('website/index.html: links updated')
}

console.log(`\nAll v${V} release prep done.`)
