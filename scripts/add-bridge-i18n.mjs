// One-shot script: add Local Agent Bridge (Codex channel) i18n keys to all
// locales. Run: node scripts/add-bridge-i18n.mjs
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('src/locales')
const translations = {
  'en-US': {
    taskTypeBridge: 'Codex bridge (official App Server)',
    bridge: {
      title: 'Local Agent Bridge · Codex',
      installed: 'Installed · {{version}}',
      notInstalled: 'Codex not detected',
      versionUnknown: 'version unknown',
      authMode: 'Sign-in: {{mode}}',
      authNone: 'not signed in',
      authUnknown: 'Sign-in state unknown — run the connection test',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connection OK · {{latency}} ms',
      testFailed: 'Connection failed',
      note: 'Tasks run as independent Codex sessions inside an isolated NEXUS workspace. Your open Codex Desktop windows and existing history are not touched; changes are delivered only after review and verification.',
      installHint: 'Codex was not detected. Install it via Settings → Development environment (winget install OpenAI.Codex) or set NEXUS_CODEX_PATH to the codex binary, then re-check.',
      usesOwnAccount: 'The Codex channel uses its own sign-in — no NEXUS provider key is needed.'
    },
    bridgeTag: 'Codex bridge'
  },
  'zh-CN': {
    taskTypeBridge: 'Codex 桥接（官方 App Server）',
    bridge: {
      title: '本地 Agent 桥接 · Codex',
      installed: '已安装 · {{version}}',
      notInstalled: '未检测到 Codex',
      versionUnknown: '版本未知',
      authMode: '登录状态：{{mode}}',
      authNone: '未登录',
      authUnknown: '登录状态未知——请先运行连接测试',
      test: '测试连接',
      testing: '正在测试…',
      testOk: '连接正常 · {{latency}} ms',
      testFailed: '连接失败',
      note: '任务以独立 Codex 会话在 NEXUS 隔离工作区内执行。已打开的 Codex Desktop 窗口与既有历史会话不受影响；改动仅在审查并通过验证后才会交付。',
      installHint: '未检测到本机 Codex。可在设置页「开发环境」一键安装（winget install OpenAI.Codex），或设置 NEXUS_CODEX_PATH 指向 codex 可执行文件后重新检测。',
      usesOwnAccount: 'Codex 通道使用其自身登录，无需配置 NEXUS 提供商密钥。'
    },
    bridgeTag: 'Codex 桥接'
  },
  'zh-TW': {
    taskTypeBridge: 'Codex 橋接（官方 App Server）',
    bridge: {
      title: '本機 Agent 橋接 · Codex',
      installed: '已安裝 · {{version}}',
      notInstalled: '未偵測到 Codex',
      versionUnknown: '版本未知',
      authMode: '登入狀態：{{mode}}',
      authNone: '未登入',
      authUnknown: '登入狀態未知——請先執行連線測試',
      test: '測試連線',
      testing: '正在測試…',
      testOk: '連線正常 · {{latency}} ms',
      testFailed: '連線失敗',
      note: '任務以獨立 Codex 工作階段在 NEXUS 隔離工作區內執行。已開啟的 Codex Desktop 視窗與既有歷史工作階段不受影響；變更僅在審查並通過驗證後才會交付。',
      installHint: '未偵測到本機 Codex。可在設定頁「開發環境」一鍵安裝（winget install OpenAI.Codex），或設定 NEXUS_CODEX_PATH 指向 codex 執行檔後重新偵測。',
      usesOwnAccount: 'Codex 通道使用其自身登入，無需設定 NEXUS 提供商金鑰。'
    },
    bridgeTag: 'Codex 橋接'
  },
  'ja-JP': {
    taskTypeBridge: 'Codex ブリッジ（公式 App Server）',
    bridge: {
      title: 'ローカル Agent ブリッジ · Codex',
      installed: 'インストール済み · {{version}}',
      notInstalled: 'Codex が見つかりません',
      versionUnknown: 'バージョン不明',
      authMode: 'サインイン状態：{{mode}}',
      authNone: '未サインイン',
      authUnknown: 'サインイン状態不明 — 接続テストを実行してください',
      test: '接続テスト',
      testing: 'テスト中…',
      testOk: '接続正常 · {{latency}} ms',
      testFailed: '接続に失敗しました',
      note: 'タスクは NEXUS の隔離ワークスペース内で独立した Codex セッションとして実行されます。開いている Codex Desktop のウィンドウや既存の履歴には影響しません。変更はレビューと検証を通過した後にのみ反映されます。',
      installHint: 'Codex が検出されませんでした。設定 → 開発環境からワンクリックインストール（winget install OpenAI.Codex）するか、NEXUS_CODEX_PATH に codex バイナリを指定して再検出してください。',
      usesOwnAccount: 'Codex チャネルは独自のサインインを使用します。NEXUS プロバイダーキーは不要です。'
    },
    bridgeTag: 'Codex ブリッジ'
  },
  'ko-KR': {
    taskTypeBridge: 'Codex 브리지(공식 App Server)',
    bridge: {
      title: '로컬 Agent 브리지 · Codex',
      installed: '설치됨 · {{version}}',
      notInstalled: 'Codex를 찾을 수 없음',
      versionUnknown: '버전 알 수 없음',
      authMode: '로그인 상태: {{mode}}',
      authNone: '로그인되지 않음',
      authUnknown: '로그인 상태 알 수 없음 — 연결 테스트를 실행하세요',
      test: '연결 테스트',
      testing: '테스트 중…',
      testOk: '연결 정상 · {{latency}} ms',
      testFailed: '연결 실패',
      note: '작업은 NEXUS 격리 작업 공간 안에서 독립적인 Codex 세션으로 실행됩니다. 열려 있는 Codex Desktop 창과 기존 기록은 영향을 받지 않으며, 변경 사항은 검토와 검증을 통과한 후에만 전달됩니다.',
      installHint: 'Codex가 감지되지 않았습니다. 설정 → 개발 환경에서 원클릭 설치(winget install OpenAI.Codex)하거나 NEXUS_CODEX_PATH에 codex 바이너리를 지정한 뒤 다시 확인하세요.',
      usesOwnAccount: 'Codex 채널은 자체 로그인을 사용하므로 NEXUS 공급자 키가 필요 없습니다.'
    },
    bridgeTag: 'Codex 브리지'
  },
  'de-DE': {
    taskTypeBridge: 'Codex-Brücke (offizieller App Server)',
    bridge: {
      title: 'Lokale-Agent-Brücke · Codex',
      installed: 'Installiert · {{version}}',
      notInstalled: 'Codex nicht erkannt',
      versionUnknown: 'Version unbekannt',
      authMode: 'Anmeldung: {{mode}}',
      authNone: 'nicht angemeldet',
      authUnknown: 'Anmeldestatus unbekannt — Verbindungstest ausführen',
      test: 'Verbindung testen',
      testing: 'Teste…',
      testOk: 'Verbindung ok · {{latency}} ms',
      testFailed: 'Verbindung fehlgeschlagen',
      note: 'Aufgaben laufen als eigenständige Codex-Sitzungen innerhalb eines isolierten NEXUS-Arbeitsbereichs. Geöffnete Codex-Desktop-Fenster und bestehende Verläufe bleiben unberührt; Änderungen werden erst nach Prüfung und Verifikation übernommen.',
      installHint: 'Codex wurde nicht erkannt. Installieren Sie es über Einstellungen → Entwicklungsumgebung (winget install OpenAI.Codex) oder setzen Sie NEXUS_CODEX_PATH auf die Codex-Binärdatei und prüfen Sie erneut.',
      usesOwnAccount: 'Der Codex-Kanal nutzt seine eigene Anmeldung — kein NEXUS-Provider-Schlüssel nötig.'
    },
    bridgeTag: 'Codex-Brücke'
  },
  'es-ES': {
    taskTypeBridge: 'Puente Codex (App Server oficial)',
    bridge: {
      title: 'Puente de agente local · Codex',
      installed: 'Instalado · {{version}}',
      notInstalled: 'Codex no detectado',
      versionUnknown: 'versión desconocida',
      authMode: 'Sesión: {{mode}}',
      authNone: 'sin sesión iniciada',
      authUnknown: 'Estado de sesión desconocido — ejecuta la prueba de conexión',
      test: 'Probar conexión',
      testing: 'Probando…',
      testOk: 'Conexión correcta · {{latency}} ms',
      testFailed: 'Error de conexión',
      note: 'Las tareas se ejecutan como sesiones de Codex independientes dentro de un espacio de trabajo aislado de NEXUS. Las ventanas abiertas de Codex Desktop y el historial existente no se tocan; los cambios solo se entregan tras revisión y verificación.',
      installHint: 'No se detectó Codex. Instálalo desde Ajustes → Entorno de desarrollo (winget install OpenAI.Codex) o define NEXUS_CODEX_PATH con la ruta del binario y vuelve a comprobar.',
      usesOwnAccount: 'El canal de Codex usa su propia sesión: no hace falta una clave de proveedor de NEXUS.'
    },
    bridgeTag: 'Puente Codex'
  },
  'fr-FR': {
    taskTypeBridge: 'Pont Codex (App Server officiel)',
    bridge: {
      title: 'Pont d’agent local · Codex',
      installed: 'Installé · {{version}}',
      notInstalled: 'Codex non détecté',
      versionUnknown: 'version inconnue',
      authMode: 'Connexion : {{mode}}',
      authNone: 'non connecté',
      authUnknown: 'État de connexion inconnu — lancez le test de connexion',
      test: 'Tester la connexion',
      testing: 'Test en cours…',
      testOk: 'Connexion OK · {{latency}} ms',
      testFailed: 'Échec de la connexion',
      note: 'Les tâches s’exécutent comme des sessions Codex indépendantes dans un espace de travail NEXUS isolé. Les fenêtres Codex Desktop ouvertes et l’historique existant ne sont pas touchés ; les modifications ne sont livrées qu’après revue et vérification.',
      installHint: 'Codex n’a pas été détecté. Installez-le via Paramètres → Environnement de développement (winget install OpenAI.Codex) ou définissez NEXUS_CODEX_PATH vers le binaire codex, puis revérifiez.',
      usesOwnAccount: 'Le canal Codex utilise sa propre connexion — aucune clé de fournisseur NEXUS requise.'
    },
    bridgeTag: 'Pont Codex'
  },
  'pt-BR': {
    taskTypeBridge: 'Ponte Codex (App Server oficial)',
    bridge: {
      title: 'Ponte de agente local · Codex',
      installed: 'Instalado · {{version}}',
      notInstalled: 'Codex não detectado',
      versionUnknown: 'versão desconhecida',
      authMode: 'Sessão: {{mode}}',
      authNone: 'não autenticado',
      authUnknown: 'Estado de autenticação desconhecido — execute o teste de conexão',
      test: 'Testar conexão',
      testing: 'Testando…',
      testOk: 'Conexão OK · {{latency}} ms',
      testFailed: 'Falha na conexão',
      note: 'As tarefas rodam como sessões Codex independentes dentro de um espaço de trabalho isolado do NEXUS. Janelas abertas do Codex Desktop e o histórico existente não são tocados; alterações só são entregues após revisão e verificação.',
      installHint: 'Codex não foi detectado. Instale-o em Configurações → Ambiente de desenvolvimento (winget install OpenAI.Codex) ou defina NEXUS_CODEX_PATH apontando para o binário do codex e verifique novamente.',
      usesOwnAccount: 'O canal Codex usa a própria autenticação — nenhuma chave de provedor do NEXUS é necessária.'
    },
    bridgeTag: 'Ponte Codex'
  },
  'ru-RU': {
    taskTypeBridge: 'Мост Codex (официальный App Server)',
    bridge: {
      title: 'Локальный мост агентов · Codex',
      installed: 'Установлен · {{version}}',
      notInstalled: 'Codex не обнаружен',
      versionUnknown: 'версия неизвестна',
      authMode: 'Вход: {{mode}}',
      authNone: 'не выполнен вход',
      authUnknown: 'Состояние входа неизвестно — запустите проверку подключения',
      test: 'Проверить подключение',
      testing: 'Проверка…',
      testOk: 'Подключение в порядке · {{latency}} мс',
      testFailed: 'Ошибка подключения',
      note: 'Задачи выполняются как независимые сессии Codex внутри изолированной рабочей области NEXUS. Открытые окна Codex Desktop и существующая история не затрагиваются; изменения передаются только после проверки и верификации.',
      installHint: 'Codex не обнаружен. Установите его через Настройки → Среда разработки (winget install OpenAI.Codex) или задайте NEXUS_CODEX_PATH на бинарный файл codex и повторите проверку.',
      usesOwnAccount: 'Канал Codex использует собственный вход — ключ провайдера NEXUS не требуется.'
    },
    bridgeTag: 'Мост Codex'
  }
}

for (const [locale, keys] of Object.entries(translations)) {
  const file = path.join(root, locale, 'agent.json')
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!data.compose.taskTypeBridge) data.compose.taskTypeBridge = keys.taskTypeBridge
  if (!data.bridge) data.bridge = keys.bridge
  if (!data.history.bridgeTag) data.history.bridgeTag = keys.bridgeTag
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  console.log(`${locale}: ok`)
}
