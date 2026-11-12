// PHASE 6 i18n update: adds agent workbench, provider manager, approval,
// verification and review keys to all 10 shipped locales.
const fs = require('node:fs')
const path = require('node:path')

const LOCALES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'de-DE', 'es-ES', 'pt-BR', 'ru-RU']
const LOCALES_DIR = path.join(__dirname, '..', 'src', 'locales')

// Per-locale strings. Keys mirror the agent.json structure additions.
const AGENT_ADDITIONS = {
  'en-US': {
    compose: {
      taskTypeLabel: 'Task engine',
      taskTypeRuntime: 'Autonomous agent (multi-turn tools)',
      taskTypeLegacy: 'Single-pass proposal (legacy)',
      approvalPolicyLabel: 'Approval policy',
      workspaceModeLabel: 'Workspace isolation',
      runtimeNote: 'The agent plans, calls real tools in an isolated workspace, runs build/tests, repairs failures and reviews its own diff. High-risk actions pause for your approval.'
    },
    policy: { supervised: 'Supervised — approve every write', standard: 'Standard — auto workspace writes, approve risky', 'workspace-auto': 'Workspace auto — only out-of-workspace asks' },
    workspaceMode: { auto: 'Auto (git worktree when possible)', worktree: 'Git worktree', copy: 'Bounded snapshot copy' },
    insights: {
      load: 'Analyze project',
      loading: 'Analyzing…',
      summary: '{{files}} files · {{languages}} languages · {{entries}} entry points',
      detailsSummary: 'Project understanding details',
      entryPoints: 'Entry points',
      scripts: 'Build & test scripts',
      languages: 'Languages',
      tests: 'Test files'
    },
    providers: {
      title: 'AI providers & keys',
      add: 'Add provider',
      empty: 'No providers registered yet. Add one to enable real agent runs.',
      encryptionUnavailable: 'OS key encryption unavailable — keys cannot be saved',
      keySaved: 'Key stored',
      keyMissing: 'No key',
      keyPlaceholder: 'Paste API key (stored encrypted, never displayed again)',
      saveKey: 'Save key',
      deleteKey: 'Delete key',
      test: 'Test connection',
      testOk: 'Connected in {{latency}} ms',
      testFail: 'Failed: {{message}}',
      deleteAria: 'Delete provider {{name}}',
      keyNote: 'API keys are encrypted with the operating system credential store, never shown again, never written to logs or project files, and forwarded only to the local service process.',
      formIncomplete: 'Name, base URL and model are required.',
      form: { name: 'Display name', kind: 'API format', model: 'Default model', baseUrl: 'Base URL', capabilities: 'Verified capabilities only', inputPrice: 'Input price / 1M tokens', outputPrice: 'Output price / 1M tokens' },
      source: { stored: 'registered', env: 'environment' }
    },
    review: {
      approvalsTitle: '{{count}} action(s) awaiting your approval',
      approve: 'Approve',
      deny: 'Deny',
      planSummary: 'Plan ({{count}} steps)',
      verificationTitle: 'Build & test verification',
      verifyLog: '{{label}}: {{ok}}',
      noOutput: '(no output)',
      reviewTitle: 'Independent diff review',
      finalMessageLabel: 'Agent summary',
      rollback: 'Roll back workspace',
      rollingBack: 'Rolling back…',
      apply: 'Apply to project',
      applying: 'Applying…'
    },
    meta: { workspaceMode: 'Workspace: {{mode}}', iterations: 'Iterations: {{value}}', toolCalls: 'Tool calls: {{value}}' },
    history: { runtimeTag: 'Autonomous run', toolCalls: '{{count}} tool calls' },
    risk: { high: 'High risk', medium: 'Medium risk', low: 'Low risk' },
    decision: { approved: 'approved', denied: 'denied' },
    events: {
      started: 'Agent runtime started',
      plan: 'Plan created',
      tool_call: 'Tool executed',
      model_retry: 'Model output retried',
      repair_start: 'Automatic repair attempt',
      repair_tool: 'Repair tool executed',
      verification: 'Build/test verification',
      review: 'Independent review',
      review_skipped: 'Review skipped',
      final: 'Final summary',
      phase: 'Phase changed',
      index: 'Project index built',
      index_failed: 'Project indexing failed',
      context: 'Task context selected',
      context_failed: 'Context selection failed',
      approval_requested: 'Approval requested',
      approval_settled: 'Approval settled',
      approval_resolved: 'Approval resolved',
      approval_expired: 'Approval expired',
      rolled_back: 'Workspace rolled back',
      applied_to_project: 'Changes applied to the project'
    }
  },
  'zh-CN': {
    compose: {
      taskTypeLabel: '任务引擎',
      taskTypeRuntime: '自主 Agent（多轮工具调用）',
      taskTypeLegacy: '单轮提案（旧版）',
      approvalPolicyLabel: '审批策略',
      workspaceModeLabel: '工作区隔离',
      runtimeNote: 'Agent 会规划任务、在隔离工作区中调用真实工具、运行构建与测试、自动修复失败并审查自己的差异。高风险操作会暂停等待您的批准。'
    },
    policy: { supervised: '监督模式 — 每次写入都需批准', standard: '标准模式 — 工作区写入自动执行，风险操作需批准', 'workspace-auto': '工作区自动 — 仅工作区外操作需批准' },
    workspaceMode: { auto: '自动（优先 Git worktree）', worktree: 'Git worktree', copy: '受限快照副本' },
    insights: {
      load: '分析项目',
      loading: '分析中…',
      summary: '{{files}} 个文件 · {{languages}} 种语言 · {{entries}} 个入口',
      detailsSummary: '项目理解详情',
      entryPoints: '入口文件',
      scripts: '构建与测试脚本',
      languages: '语言构成',
      tests: '测试文件'
    },
    providers: {
      title: 'AI Provider 与密钥',
      add: '添加 Provider',
      empty: '尚未注册任何 Provider。添加一个以启用真实的 Agent 运行。',
      encryptionUnavailable: '操作系统密钥加密不可用 — 无法保存密钥',
      keySaved: '密钥已保存',
      keyMissing: '未配置密钥',
      keyPlaceholder: '粘贴 API 密钥（加密存储，之后不再显示）',
      saveKey: '保存密钥',
      deleteKey: '删除密钥',
      test: '测试连接',
      testOk: '连接成功（{{latency}} 毫秒）',
      testFail: '失败：{{message}}',
      deleteAria: '删除 Provider {{name}}',
      keyNote: 'API 密钥使用操作系统凭据库加密保存，不会再次显示，不会写入日志或项目文件，仅转发给本地服务进程。',
      formIncomplete: '名称、Base URL 和模型为必填项。',
      form: { name: '显示名称', kind: 'API 格式', model: '默认模型', baseUrl: 'Base URL', capabilities: '仅勾选已验证的能力', inputPrice: '输入价格 / 每百万 Token', outputPrice: '输出价格 / 每百万 Token' },
      source: { stored: '已注册', env: '环境变量' }
    },
    review: {
      approvalsTitle: '{{count}} 项操作等待您的批准',
      approve: '批准',
      deny: '拒绝',
      planSummary: '任务计划（{{count}} 步）',
      verificationTitle: '构建与测试验证',
      verifyLog: '{{label}}：{{ok}}',
      noOutput: '（无输出）',
      reviewTitle: '独立差异审查',
      finalMessageLabel: 'Agent 总结',
      rollback: '回滚工作区',
      rollingBack: '回滚中…',
      apply: '应用到项目',
      applying: '应用中…'
    },
    meta: { workspaceMode: '工作区：{{mode}}', iterations: '迭代次数：{{value}}', toolCalls: '工具调用：{{value}}' },
    history: { runtimeTag: '自主运行', toolCalls: '{{count}} 次工具调用' },
    risk: { high: '高风险', medium: '中风险', low: '低风险' },
    decision: { approved: '批准', denied: '拒绝' },
    events: {
      started: 'Agent 运行时已启动',
      plan: '已生成计划',
      tool_call: '工具已执行',
      model_retry: '模型输出已重试',
      repair_start: '自动修复尝试',
      repair_tool: '修复工具已执行',
      verification: '构建/测试验证',
      review: '独立审查',
      review_skipped: '审查已跳过',
      final: '最终总结',
      phase: '阶段变更',
      index: '项目索引已建立',
      index_failed: '项目索引失败',
      context: '任务上下文已选定',
      context_failed: '上下文选择失败',
      approval_requested: '请求批准',
      approval_settled: '批准已处理',
      approval_resolved: '批准已决定',
      approval_expired: '批准已过期',
      rolled_back: '工作区已回滚',
      applied_to_project: '修改已应用到项目'
    }
  },
  'zh-TW': {
    compose: {
      taskTypeLabel: '任務引擎',
      taskTypeRuntime: '自主 Agent（多輪工具呼叫）',
      taskTypeLegacy: '單輪提案（舊版）',
      approvalPolicyLabel: '核准策略',
      workspaceModeLabel: '工作區隔離',
      runtimeNote: 'Agent 會規劃任務、在隔離工作區中呼叫真實工具、執行建置與測試、自動修復失敗並審查自己的差異。高風險操作會暫停等待您的核准。'
    },
    policy: { supervised: '監督模式 — 每次寫入都需核准', standard: '標準模式 — 工作區寫入自動執行，風險操作需核准', 'workspace-auto': '工作區自動 — 僅工作區外操作需核准' },
    workspaceMode: { auto: '自動（優先 Git worktree）', worktree: 'Git worktree', copy: '受限快照副本' },
    insights: {
      load: '分析專案',
      loading: '分析中…',
      summary: '{{files}} 個檔案 · {{languages}} 種語言 · {{entries}} 個進入點',
      detailsSummary: '專案理解詳情',
      entryPoints: '進入點',
      scripts: '建置與測試腳本',
      languages: '語言構成',
      tests: '測試檔案'
    },
    providers: {
      title: 'AI Provider 與金鑰',
      add: '新增 Provider',
      empty: '尚未註冊任何 Provider。新增一個以啟用真實的 Agent 執行。',
      encryptionUnavailable: '作業系統金鑰加密不可用 — 無法儲存金鑰',
      keySaved: '金鑰已儲存',
      keyMissing: '未設定金鑰',
      keyPlaceholder: '貼上 API 金鑰（加密儲存，之後不再顯示）',
      saveKey: '儲存金鑰',
      deleteKey: '刪除金鑰',
      test: '測試連線',
      testOk: '連線成功（{{latency}} 毫秒）',
      testFail: '失敗：{{message}}',
      deleteAria: '刪除 Provider {{name}}',
      keyNote: 'API 金鑰使用作業系統憑證庫加密保存，不會再次顯示，不會寫入日誌或專案檔案，僅轉發給本機服務程序。',
      formIncomplete: '名稱、Base URL 與模型為必填欄位。',
      form: { name: '顯示名稱', kind: 'API 格式', model: '預設模型', baseUrl: 'Base URL', capabilities: '僅勾選已驗證的能力', inputPrice: '輸入價格 / 每百萬 Token', outputPrice: '輸出價格 / 每百萬 Token' },
      source: { stored: '已註冊', env: '環境變數' }
    },
    review: {
      approvalsTitle: '{{count}} 項操作等待您的核准',
      approve: '核准',
      deny: '拒絕',
      planSummary: '任務計畫（{{count}} 步）',
      verificationTitle: '建置與測試驗證',
      verifyLog: '{{label}}：{{ok}}',
      noOutput: '（無輸出）',
      reviewTitle: '獨立差異審查',
      finalMessageLabel: 'Agent 總結',
      rollback: '回復工作區',
      rollingBack: '回復中…',
      apply: '套用到專案',
      applying: '套用中…'
    },
    meta: { workspaceMode: '工作區：{{mode}}', iterations: '迭代次數：{{value}}', toolCalls: '工具呼叫：{{value}}' },
    history: { runtimeTag: '自主執行', toolCalls: '{{count}} 次工具呼叫' },
    risk: { high: '高風險', medium: '中風險', low: '低風險' },
    decision: { approved: '核准', denied: '拒絕' },
    events: {
      started: 'Agent 執行環境已啟動',
      plan: '已產生計畫',
      tool_call: '工具已執行',
      model_retry: '模型輸出已重試',
      repair_start: '自動修復嘗試',
      repair_tool: '修復工具已執行',
      verification: '建置/測試驗證',
      review: '獨立審查',
      review_skipped: '審查已略過',
      final: '最終總結',
      phase: '階段變更',
      index: '專案索引已建立',
      index_failed: '專案索引失敗',
      context: '任務上下文已選定',
      context_failed: '上下文選擇失敗',
      approval_requested: '請求核准',
      approval_settled: '核准已處理',
      approval_resolved: '核准已決定',
      approval_expired: '核准已逾期',
      rolled_back: '工作區已回復',
      applied_to_project: '修改已套用到專案'
    }
  },
  'ja-JP': {
    compose: {
      taskTypeLabel: 'タスクエンジン',
      taskTypeRuntime: '自律エージェント（マルチターンツール実行）',
      taskTypeLegacy: '単一パス提案（従来）',
      approvalPolicyLabel: '承認ポリシー',
      workspaceModeLabel: 'ワークスペース分離',
      runtimeNote: 'エージェントは計画を立て、分離されたワークスペースで実際のツールを呼び出し、ビルドとテストを実行し、失敗を自動修復し、自らの差分をレビューします。高リスク操作は承認のために一時停止します。'
    },
    policy: { supervised: '監督モード — すべての書き込みを承認', standard: '標準モード — ワークスペース書き込みは自動、リスク操作は承認', 'workspace-auto': 'ワークスペース自動 — ワークスペース外のみ承認' },
    workspaceMode: { auto: '自動（可能なら Git worktree）', worktree: 'Git worktree', copy: '制限付きスナップショットコピー' },
    insights: {
      load: 'プロジェクトを分析',
      loading: '分析中…',
      summary: '{{files}} ファイル · {{languages}} 言語 · {{entries}} エントリーポイント',
      detailsSummary: 'プロジェクト理解の詳細',
      entryPoints: 'エントリーポイント',
      scripts: 'ビルド & テストスクリプト',
      languages: '言語構成',
      tests: 'テストファイル'
    },
    providers: {
      title: 'AI プロバイダーとキー',
      add: 'プロバイダーを追加',
      empty: 'プロバイダーが未登録です。追加すると実際のエージェント実行が可能になります。',
      encryptionUnavailable: 'OS のキー暗号化が利用不可 — キーを保存できません',
      keySaved: 'キー保存済み',
      keyMissing: 'キー未設定',
      keyPlaceholder: 'API キーを貼り付け（暗号化保存、再表示なし）',
      saveKey: 'キーを保存',
      deleteKey: 'キーを削除',
      test: '接続テスト',
      testOk: '接続成功（{{latency}} ミリ秒）',
      testFail: '失敗：{{message}}',
      deleteAria: 'プロバイダー {{name}} を削除',
      keyNote: 'API キーは OS の資格情報ストアで暗号化され、再表示されず、ログやプロジェクトファイルにも書き込まれず、ローカルサービスプロセスにのみ転送されます。',
      formIncomplete: '名前・Base URL・モデルは必須です。',
      form: { name: '表示名', kind: 'API 形式', model: '既定モデル', baseUrl: 'Base URL', capabilities: '検証済みの能力のみ選択', inputPrice: '入力価格 / 100万トークン', outputPrice: '出力価格 / 100万トークン' },
      source: { stored: '登録済み', env: '環境変数' }
    },
    review: {
      approvalsTitle: '{{count}} 件の操作が承認待ち',
      approve: '承認',
      deny: '拒否',
      planSummary: '計画（{{count}} ステップ）',
      verificationTitle: 'ビルド & テスト検証',
      verifyLog: '{{label}}：{{ok}}',
      noOutput: '（出力なし）',
      reviewTitle: '独立差分レビュー',
      finalMessageLabel: 'エージェントの要約',
      rollback: 'ワークスペースを復元',
      rollingBack: '復元中…',
      apply: 'プロジェクトに適用',
      applying: '適用中…'
    },
    meta: { workspaceMode: 'ワークスペース：{{mode}}', iterations: '反復：{{value}}', toolCalls: 'ツール呼び出し：{{value}}' },
    history: { runtimeTag: '自律実行', toolCalls: '{{count}} 回のツール呼び出し' },
    risk: { high: '高リスク', medium: '中リスク', low: '低リスク' },
    decision: { approved: '承認', denied: '拒否' },
    events: {
      started: 'エージェントランタイム開始',
      plan: '計画作成',
      tool_call: 'ツール実行',
      model_retry: 'モデル出力を再試行',
      repair_start: '自動修復の試行',
      repair_tool: '修復ツール実行',
      verification: 'ビルド/テスト検証',
      review: '独立レビュー',
      review_skipped: 'レビューをスキップ',
      final: '最終要約',
      phase: 'フェーズ変更',
      index: 'プロジェクトインデックス作成',
      index_failed: 'インデックス作成失敗',
      context: 'タスクコンテキスト選択',
      context_failed: 'コンテキスト選択失敗',
      approval_requested: '承認を要求',
      approval_settled: '承認処理済み',
      approval_resolved: '承認決定済み',
      approval_expired: '承認期限切れ',
      rolled_back: 'ワークスペースを復元',
      applied_to_project: '変更をプロジェクトに適用'
    }
  },
  'ko-KR': {
    compose: {
      taskTypeLabel: '작업 엔진',
      taskTypeRuntime: '자율 에이전트(다중 턴 도구 실행)',
      taskTypeLegacy: '단일 패스 제안(레거시)',
      approvalPolicyLabel: '승인 정책',
      workspaceModeLabel: '작업 공간 격리',
      runtimeNote: '에이전트가 계획을 세우고 격리된 작업 공간에서 실제 도구를 호출하며, 빌드와 테스트를 실행하고, 실패를 자동 복구하고, 자체 diff를 검토합니다. 고위험 작업은 승인을 위해 일시 중지됩니다.'
    },
    policy: { supervised: '감독 모드 — 모든 쓰기 승인 필요', standard: '표준 모드 — 작업 공간 쓰기 자동, 위험 작업 승인', 'workspace-auto': '작업 공간 자동 — 작업 공간 외부만 승인' },
    workspaceMode: { auto: '자동(가능하면 Git worktree)', worktree: 'Git worktree', copy: '제한된 스냅샷 복사' },
    insights: {
      load: '프로젝트 분석',
      loading: '분석 중…',
      summary: '{{files}}개 파일 · {{languages}}개 언어 · {{entries}}개 진입점',
      detailsSummary: '프로젝트 이해 상세',
      entryPoints: '진입점',
      scripts: '빌드 & 테스트 스크립트',
      languages: '언어 구성',
      tests: '테스트 파일'
    },
    providers: {
      title: 'AI 공급자 및 키',
      add: '공급자 추가',
      empty: '등록된 공급자가 없습니다. 추가하면 실제 에이전트 실행이 가능합니다.',
      encryptionUnavailable: 'OS 키 암호화를 사용할 수 없음 — 키를 저장할 수 없습니다',
      keySaved: '키 저장됨',
      keyMissing: '키 없음',
      keyPlaceholder: 'API 키 붙여넣기(암호화 저장, 다시 표시 안 함)',
      saveKey: '키 저장',
      deleteKey: '키 삭제',
      test: '연결 테스트',
      testOk: '연결 성공({{latency}}ms)',
      testFail: '실패: {{message}}',
      deleteAria: '공급자 {{name}} 삭제',
      keyNote: 'API 키는 OS 자격 증명 저장소로 암호화되어 저장되며, 다시 표시되지 않고, 로그나 프로젝트 파일에 기록되지 않으며, 로컬 서비스 프로세스에만 전달됩니다.',
      formIncomplete: '이름, Base URL, 모델은 필수입니다.',
      form: { name: '표시 이름', kind: 'API 형식', model: '기본 모델', baseUrl: 'Base URL', capabilities: '검증된 기능만 선택', inputPrice: '입력 가격 / 백만 토큰', outputPrice: '출력 가격 / 백만 토큰' },
      source: { stored: '등록됨', env: '환경 변수' }
    },
    review: {
      approvalsTitle: '{{count}}개 작업이 승인 대기 중',
      approve: '승인',
      deny: '거부',
      planSummary: '계획({{count}}단계)',
      verificationTitle: '빌드 & 테스트 검증',
      verifyLog: '{{label}}: {{ok}}',
      noOutput: '(출력 없음)',
      reviewTitle: '독립 diff 검토',
      finalMessageLabel: '에이전트 요약',
      rollback: '작업 공간 복원',
      rollingBack: '복원 중…',
      apply: '프로젝트에 적용',
      applying: '적용 중…'
    },
    meta: { workspaceMode: '작업 공간: {{mode}}', iterations: '반복: {{value}}', toolCalls: '도구 호출: {{value}}' },
    history: { runtimeTag: '자율 실행', toolCalls: '{{count}}회 도구 호출' },
    risk: { high: '고위험', medium: '중위험', low: '저위험' },
    decision: { approved: '승인', denied: '거부' },
    events: {
      started: '에이전트 런타임 시작',
      plan: '계획 생성됨',
      tool_call: '도구 실행됨',
      model_retry: '모델 출력 재시도',
      repair_start: '자동 복구 시도',
      repair_tool: '복구 도구 실행됨',
      verification: '빌드/테스트 검증',
      review: '독립 검토',
      review_skipped: '검토 건너뜀',
      final: '최종 요약',
      phase: '단계 변경',
      index: '프로젝트 인덱스 생성됨',
      index_failed: '인덱스 생성 실패',
      context: '작업 컨텍스트 선택됨',
      context_failed: '컨텍스트 선택 실패',
      approval_requested: '승인 요청됨',
      approval_settled: '승인 처리됨',
      approval_resolved: '승인 결정됨',
      approval_expired: '승인 만료됨',
      rolled_back: '작업 공간 복원됨',
      applied_to_project: '변경 사항이 프로젝트에 적용됨'
    }
  },
  'fr-FR': {
    compose: {
      taskTypeLabel: 'Moteur de tâche',
      taskTypeRuntime: 'Agent autonome (outils multi-tours)',
      taskTypeLegacy: 'Proposition en une passe (historique)',
      approvalPolicyLabel: 'Politique d’approbation',
      workspaceModeLabel: 'Isolation de l’espace de travail',
      runtimeNote: 'L’agent planifie, appelle de vrais outils dans un espace de travail isolé, exécute build/tests, répare les échecs et relit son propre diff. Les actions à haut risque s’arrêtent pour votre approbation.'
    },
    policy: { supervised: 'Supervisé — approuver chaque écriture', standard: 'Standard — écritures automatiques dans l’espace de travail, actions risquées approuvées', 'workspace-auto': 'Espace auto — seulement hors espace de travail' },
    workspaceMode: { auto: 'Auto (git worktree si possible)', worktree: 'Git worktree', copy: 'Copie instantané délimitée' },
    insights: {
      load: 'Analyser le projet',
      loading: 'Analyse…',
      summary: '{{files}} fichiers · {{languages}} langages · {{entries}} points d’entrée',
      detailsSummary: 'Détails de la compréhension du projet',
      entryPoints: 'Points d’entrée',
      scripts: 'Scripts de build & test',
      languages: 'Langages',
      tests: 'Fichiers de test'
    },
    providers: {
      title: 'Fournisseurs IA & clés',
      add: 'Ajouter un fournisseur',
      empty: 'Aucun fournisseur enregistré. Ajoutez-en un pour activer les exécutions réelles de l’agent.',
      encryptionUnavailable: 'Chiffrement des clés indisponible — impossible d’enregistrer les clés',
      keySaved: 'Clé enregistrée',
      keyMissing: 'Aucune clé',
      keyPlaceholder: 'Collez la clé API (stockée chiffrée, plus jamais affichée)',
      saveKey: 'Enregistrer la clé',
      deleteKey: 'Supprimer la clé',
      test: 'Tester la connexion',
      testOk: 'Connecté en {{latency}} ms',
      testFail: 'Échec : {{message}}',
      deleteAria: 'Supprimer le fournisseur {{name}}',
      keyNote: 'Les clés API sont chiffrées via le magasin d’identifiants du système, ne sont plus jamais affichées, jamais écrites dans les journaux ou fichiers de projet, et transmises uniquement au processus de service local.',
      formIncomplete: 'Le nom, l’URL de base et le modèle sont obligatoires.',
      form: { name: 'Nom affiché', kind: 'Format d’API', model: 'Modèle par défaut', baseUrl: 'URL de base', capabilities: 'Capacités vérifiées uniquement', inputPrice: 'Prix d’entrée / 1M jetons', outputPrice: 'Prix de sortie / 1M jetons' },
      source: { stored: 'enregistré', env: 'environnement' }
    },
    review: {
      approvalsTitle: '{{count}} action(s) en attente d’approbation',
      approve: 'Approuver',
      deny: 'Refuser',
      planSummary: 'Plan ({{count}} étapes)',
      verificationTitle: 'Vérification build & tests',
      verifyLog: '{{label}} : {{ok}}',
      noOutput: '(aucune sortie)',
      reviewTitle: 'Revue indépendante du diff',
      finalMessageLabel: 'Résumé de l’agent',
      rollback: 'Restaurer l’espace de travail',
      rollingBack: 'Restauration…',
      apply: 'Appliquer au projet',
      applying: 'Application…'
    },
    meta: { workspaceMode: 'Espace de travail : {{mode}}', iterations: 'Itérations : {{value}}', toolCalls: 'Appels d’outils : {{value}}' },
    history: { runtimeTag: 'Exécution autonome', toolCalls: '{{count}} appels d’outils' },
    risk: { high: 'Risque élevé', medium: 'Risque moyen', low: 'Risque faible' },
    decision: { approved: 'approuvée', denied: 'refusée' },
    events: {
      started: 'Agent démarré',
      plan: 'Plan créé',
      tool_call: 'Outil exécuté',
      model_retry: 'Sortie du modèle réessayée',
      repair_start: 'Tentative de réparation automatique',
      repair_tool: 'Outil de réparation exécuté',
      verification: 'Vérification build/tests',
      review: 'Revue indépendante',
      review_skipped: 'Revue ignorée',
      final: 'Résumé final',
      phase: 'Changement de phase',
      index: 'Index du projet créé',
      index_failed: 'Échec de l’indexation',
      context: 'Contexte de tâche sélectionné',
      context_failed: 'Échec de la sélection de contexte',
      approval_requested: 'Approbation demandée',
      approval_settled: 'Approbation traitée',
      approval_resolved: 'Approbation décidée',
      approval_expired: 'Approbation expirée',
      rolled_back: 'Espace de travail restauré',
      applied_to_project: 'Modifications appliquées au projet'
    }
  },
  'de-DE': {
    compose: {
      taskTypeLabel: 'Task-Engine',
      taskTypeRuntime: 'Autonomer Agent (mehrstufige Tool-Aufrufe)',
      taskTypeLegacy: 'Einmalvorschlag (veraltet)',
      approvalPolicyLabel: 'Genehmigungsrichtlinie',
      workspaceModeLabel: 'Workspace-Isolation',
      runtimeNote: 'Der Agent plant, ruft echte Tools in einem isolierten Workspace auf, führt Build/Tests aus, repariert Fehler und prüft sein eigenes Diff. Hochriskante Aktionen pausieren für Ihre Genehmigung.'
    },
    policy: { supervised: 'Überwacht — jede Schreibaktion genehmigen', standard: 'Standard — Workspace-Schreibaktionen automatisch, riskante Aktionen genehmigen', 'workspace-auto': 'Workspace automatisch — nur außerhalb des Workspace nachfragen' },
    workspaceMode: { auto: 'Automatisch (wenn möglich Git-Worktree)', worktree: 'Git-Worktree', copy: 'Begrenzte Snapshot-Kopie' },
    insights: {
      load: 'Projekt analysieren',
      loading: 'Analyse…',
      summary: '{{files}} Dateien · {{languages}} Sprachen · {{entries}} Einstiegspunkte',
      detailsSummary: 'Details des Projektverständnisses',
      entryPoints: 'Einstiegspunkte',
      scripts: 'Build- & Test-Skripte',
      languages: 'Sprachen',
      tests: 'Testdateien'
    },
    providers: {
      title: 'KI-Anbieter & Schlüssel',
      add: 'Anbieter hinzufügen',
      empty: 'Noch keine Anbieter registriert. Fügen Sie einen hinzu, um echte Agent-Läufe zu ermöglichen.',
      encryptionUnavailable: 'Betriebssystem-Schlüsselverschlüsselung nicht verfügbar — Schlüssel können nicht gespeichert werden',
      keySaved: 'Schlüssel gespeichert',
      keyMissing: 'Kein Schlüssel',
      keyPlaceholder: 'API-Schlüssel einfügen (verschlüsselt gespeichert, nie wieder angezeigt)',
      saveKey: 'Schlüssel speichern',
      deleteKey: 'Schlüssel löschen',
      test: 'Verbindung testen',
      testOk: 'Verbunden in {{latency}} ms',
      testFail: 'Fehlgeschlagen: {{message}}',
      deleteAria: 'Anbieter {{name}} löschen',
      keyNote: 'API-Schlüssel werden mit dem Betriebssystem-Anmeldedatenspeicher verschlüsselt, nie wieder angezeigt, nie in Protokolle oder Projektdateien geschrieben und nur an den lokalen Dienstprozess übermittelt.',
      formIncomplete: 'Name, Basis-URL und Modell sind erforderlich.',
      form: { name: 'Anzeigename', kind: 'API-Format', model: 'Standardmodell', baseUrl: 'Basis-URL', capabilities: 'Nur verifizierte Fähigkeiten', inputPrice: 'Eingabepreis / 1M Token', outputPrice: 'Ausgabepreis / 1M Token' },
      source: { stored: 'registriert', env: 'Umgebung' }
    },
    review: {
      approvalsTitle: '{{count}} Aktion(en) awaiting your approval',
      approve: 'Genehmigen',
      deny: 'Ablehnen',
      planSummary: 'Plan ({{count}} Schritte)',
      verificationTitle: 'Build- & Test-Verifikation',
      verifyLog: '{{label}}: {{ok}}',
      noOutput: '(keine Ausgabe)',
      reviewTitle: 'Unabhängige Diff-Prüfung',
      finalMessageLabel: 'Agent-Zusammenfassung',
      rollback: 'Workspace zurücksetzen',
      rollingBack: 'Zurücksetzen…',
      apply: 'Auf Projekt anwenden',
      applying: 'Anwenden…'
    },
    meta: { workspaceMode: 'Workspace: {{mode}}', iterations: 'Iterationen: {{value}}', toolCalls: 'Tool-Aufrufe: {{value}}' },
    history: { runtimeTag: 'Autonomer Lauf', toolCalls: '{{count}} Tool-Aufrufe' },
    risk: { high: 'Hohes Risiko', medium: 'Mittleres Risiko', low: 'Geringes Risiko' },
    decision: { approved: 'genehmigt', denied: 'abgelehnt' },
    events: {
      started: 'Agent-Laufzeit gestartet',
      plan: 'Plan erstellt',
      tool_call: 'Tool ausgeführt',
      model_retry: 'Modellausgabe wiederholt',
      repair_start: 'Automatischer Reparaturversuch',
      repair_tool: 'Reparatur-Tool ausgeführt',
      verification: 'Build/Test-Verifikation',
      review: 'Unabhängige Prüfung',
      review_skipped: 'Prüfung übersprungen',
      final: 'Abschließende Zusammenfassung',
      phase: 'Phase geändert',
      index: 'Projektindex erstellt',
      index_failed: 'Projektindizierung fehlgeschlagen',
      context: 'Aufgabenkontext ausgewählt',
      context_failed: 'Kontextauswahl fehlgeschlagen',
      approval_requested: 'Genehmigung angefordert',
      approval_settled: 'Genehmigung entschieden',
      approval_resolved: 'Genehmigung entschieden',
      approval_expired: 'Genehmigung abgelaufen',
      rolled_back: 'Workspace zurückgesetzt',
      applied_to_project: 'Änderungen auf das Projekt angewendet'
    }
  },
  'es-ES': {
    compose: {
      taskTypeLabel: 'Motor de tareas',
      taskTypeRuntime: 'Agente autónomo (herramientas multipaso)',
      taskTypeLegacy: 'Propuesta de una pasada (heredado)',
      approvalPolicyLabel: 'Política de aprobación',
      workspaceModeLabel: 'Aislamiento del espacio de trabajo',
      runtimeNote: 'El agente planifica, invoca herramientas reales en un espacio de trabajo aislado, ejecuta build/pruebas, repara fallos y revisa su propio diff. Las acciones de alto riesgo se pausan para su aprobación.'
    },
    policy: { supervised: 'Supervisado — aprobar cada escritura', standard: 'Estándar — escrituras automáticas en el espacio de trabajo, acciones riesgosas requieren aprobación', 'workspace-auto': 'Espacio automático — solo fuera del espacio de trabajo' },
    workspaceMode: { auto: 'Automático (git worktree si es posible)', worktree: 'Git worktree', copy: 'Copia instantánea delimitada' },
    insights: {
      load: 'Analizar proyecto',
      loading: 'Analizando…',
      summary: '{{files}} archivos · {{languages}} lenguajes · {{entries}} puntos de entrada',
      detailsSummary: 'Detalles de la comprensión del proyecto',
      entryPoints: 'Puntos de entrada',
      scripts: 'Scripts de build y pruebas',
      languages: 'Lenguajes',
      tests: 'Archivos de prueba'
    },
    providers: {
      title: 'Proveedores de IA y claves',
      add: 'Añadir proveedor',
      empty: 'Aún no hay proveedores registrados. Añade uno para permitir ejecuciones reales del agente.',
      encryptionUnavailable: 'Cifrado de claves del SO no disponible — no se pueden guardar claves',
      keySaved: 'Clave guardada',
      keyMissing: 'Sin clave',
      keyPlaceholder: 'Pega la clave API (guardada cifrada, no se vuelve a mostrar)',
      saveKey: 'Guardar clave',
      deleteKey: 'Eliminar clave',
      test: 'Probar conexión',
      testOk: 'Conectado en {{latency}} ms',
      testFail: 'Falló: {{message}}',
      deleteAria: 'Eliminar el proveedor {{name}}',
      keyNote: 'Las claves API se cifran con el almacén de credenciales del sistema operativo, no se vuelven a mostrar, nunca se escriben en registros ni archivos del proyecto, y solo se reenvían al proceso del servicio local.',
      formIncomplete: 'El nombre, la URL base y el modelo son obligatorios.',
      form: { name: 'Nombre visible', kind: 'Formato de API', model: 'Modelo predeterminado', baseUrl: 'URL base', capabilities: 'Solo capacidades verificadas', inputPrice: 'Precio de entrada / 1M tokens', outputPrice: 'Precio de salida / 1M tokens' },
      source: { stored: 'registrado', env: 'entorno' }
    },
    review: {
      approvalsTitle: '{{count}} acción(es) en espera de tu aprobación',
      approve: 'Aprobar',
      deny: 'Denegar',
      planSummary: 'Plan ({{count}} pasos)',
      verificationTitle: 'Verificación de build y pruebas',
      verifyLog: '{{label}}: {{ok}}',
      noOutput: '(sin salida)',
      reviewTitle: 'Revisión independiente del diff',
      finalMessageLabel: 'Resumen del agente',
      rollback: 'Restaurar espacio de trabajo',
      rollingBack: 'Restaurando…',
      apply: 'Aplicar al proyecto',
      applying: 'Aplicando…'
    },
    meta: { workspaceMode: 'Espacio de trabajo: {{mode}}', iterations: 'Iteraciones: {{value}}', toolCalls: 'Llamadas a herramientas: {{value}}' },
    history: { runtimeTag: 'Ejecución autónoma', toolCalls: '{{count}} llamadas a herramientas' },
    risk: { high: 'Riesgo alto', medium: 'Riesgo medio', low: 'Riesgo bajo' },
    decision: { approved: 'aprobada', denied: 'denegada' },
    events: {
      started: 'Runtime del agente iniciado',
      plan: 'Plan creado',
      tool_call: 'Herramienta ejecutada',
      model_retry: 'Salida del modelo reintentada',
      repair_start: 'Intento de reparación automática',
      repair_tool: 'Herramienta de reparación ejecutada',
      verification: 'Verificación de build/pruebas',
      review: 'Revisión independiente',
      review_skipped: 'Revisión omitida',
      final: 'Resumen final',
      phase: 'Cambio de fase',
      index: 'Índice del proyecto creado',
      index_failed: 'Falló la indexación del proyecto',
      context: 'Contexto de la tarea seleccionado',
      context_failed: 'Falló la selección de contexto',
      approval_requested: 'Aprobación solicitada',
      approval_settled: 'Aprobación resuelta',
      approval_resolved: 'Aprobación decidida',
      approval_expired: 'Aprobación expirada',
      rolled_back: 'Espacio de trabajo restaurado',
      applied_to_project: 'Cambios aplicados al proyecto'
    }
  },
  'pt-BR': {
    compose: {
      taskTypeLabel: 'Motor de tarefas',
      taskTypeRuntime: 'Agente autônomo (ferramentas em múltiplas rodadas)',
      taskTypeLegacy: 'Proposta de passada única (legado)',
      approvalPolicyLabel: 'Política de aprovação',
      workspaceModeLabel: 'Isolamento do espaço de trabalho',
      runtimeNote: 'O agente planeia, chama ferramentas reais em um espaço de trabalho isolado, executa build/testes, repara falhas e revisa o próprio diff. Ações de alto risco pausam para sua aprovação.'
    },
    policy: { supervised: 'Supervisionado — aprovar cada escrita', standard: 'Padrão — escritas no espaço de trabalho automáticas, ações arriscadas exigem aprovação', 'workspace-auto': 'Espaço automático — apenas fora do espaço de trabalho' },
    workspaceMode: { auto: 'Automático (git worktree quando possível)', worktree: 'Git worktree', copy: 'Cópia de snapshot delimitada' },
    insights: {
      load: 'Analisar projeto',
      loading: 'Analisando…',
      summary: '{{files}} arquivos · {{languages}} linguagens · {{entries}} pontos de entrada',
      detailsSummary: 'Detalhes da compreensão do projeto',
      entryPoints: 'Pontos de entrada',
      scripts: 'Scripts de build e teste',
      languages: 'Linguagens',
      tests: 'Arquivos de teste'
    },
    providers: {
      title: 'Provedores de IA e chaves',
      add: 'Adicionar provedor',
      empty: 'Nenhum provedor registrado ainda. Adicione um para permitir execuções reais do agente.',
      encryptionUnavailable: 'Criptografia de chaves do SO indisponível — não é possível salvar chaves',
      keySaved: 'Chave salva',
      keyMissing: 'Sem chave',
      keyPlaceholder: 'Cole a chave de API (armazenada cifrada, nunca mais exibida)',
      saveKey: 'Salvar chave',
      deleteKey: 'Excluir chave',
      test: 'Testar conexão',
      testOk: 'Conectado em {{latency}} ms',
      testFail: 'Falhou: {{message}}',
      deleteAria: 'Excluir o provedor {{name}}',
      keyNote: 'As chaves de API são criptografadas com o cofre de credenciais do sistema operacional, nunca mais exibidas, nunca escritas em logs ou arquivos do projeto e repassadas apenas ao processo de serviço local.',
      formIncomplete: 'Nome, URL base e modelo são obrigatórios.',
      form: { name: 'Nome de exibição', kind: 'Formato de API', model: 'Modelo padrão', baseUrl: 'URL base', capabilities: 'Apenas capacidades verificadas', inputPrice: 'Preço de entrada / 1M tokens', outputPrice: 'Preço de saída / 1M tokens' },
      source: { stored: 'registrado', env: 'ambiente' }
    },
    review: {
      approvalsTitle: '{{count}} ação(ões) aguardando sua aprovação',
      approve: 'Aprovar',
      deny: 'Negar',
      planSummary: 'Plano ({{count}} passos)',
      verificationTitle: 'Verificação de build e testes',
      verifyLog: '{{label}}: {{ok}}',
      noOutput: '(sem saída)',
      reviewTitle: 'Revisão independente do diff',
      finalMessageLabel: 'Resumo do agente',
      rollback: 'Reverter espaço de trabalho',
      rollingBack: 'Revertendo…',
      apply: 'Aplicar ao projeto',
      applying: 'Aplicando…'
    },
    meta: { workspaceMode: 'Espaço de trabalho: {{mode}}', iterations: 'Iterações: {{value}}', toolCalls: 'Chamadas de ferramentas: {{value}}' },
    history: { runtimeTag: 'Execução autônoma', toolCalls: '{{count}} chamadas de ferramentas' },
    risk: { high: 'Risco alto', medium: 'Risco médio', low: 'Risco baixo' },
    decision: { approved: 'aprovada', denied: 'negada' },
    events: {
      started: 'Runtime do agente iniciado',
      plan: 'Plano criado',
      tool_call: 'Ferramenta executada',
      model_retry: 'Saída do modelo repetida',
      repair_start: 'Tentativa de reparo automático',
      repair_tool: 'Ferramenta de reparo executada',
      verification: 'Verificação de build/testes',
      review: 'Revisão independente',
      review_skipped: 'Revisão ignorada',
      final: 'Resumo final',
      phase: 'Fase alterada',
      index: 'Índice do projeto criado',
      index_failed: 'Falha na indexação do projeto',
      context: 'Contexto da tarefa selecionado',
      context_failed: 'Falha na seleção de contexto',
      approval_requested: 'Aprovação solicitada',
      approval_settled: 'Aprovação resolvida',
      approval_resolved: 'Aprovação decidida',
      approval_expired: 'Aprovação expirada',
      rolled_back: 'Espaço de trabalho revertido',
      applied_to_project: 'Alterações aplicadas ao projeto'
    }
  },
  'ru-RU': {
    compose: {
      taskTypeLabel: 'Движок задач',
      taskTypeRuntime: 'Автономный агент (многоразовый вызов инструментов)',
      taskTypeLegacy: 'Однопроходное предложение (устаревшее)',
      approvalPolicyLabel: 'Политика одобрения',
      workspaceModeLabel: 'Изоляция рабочей области',
      runtimeNote: 'Агент составляет план, вызывает реальные инструменты в изолированной рабочей области, запускает сборку и тесты, исправляет сбои и проверяет свой diff. Действия высокого риска приостанавливаются для вашего одобрения.'
    },
    policy: { supervised: 'Контролируемый — одобрять каждую запись', standard: 'Стандартный — записи в рабочей области автоматически, рискованные действия с одобрения', 'workspace-auto': 'Рабочая область автоматически — одобрять только вне её' },
    workspaceMode: { auto: 'Авто (git worktree, если возможно)', worktree: 'Git worktree', copy: 'Ограниченная копия-снимок' },
    insights: {
      load: 'Проанализировать проект',
      loading: 'Анализ…',
      summary: '{{files}} файлов · {{languages}} языков · {{entries}} точек входа',
      detailsSummary: 'Детали понимания проекта',
      entryPoints: 'Точки входа',
      scripts: 'Скрипты сборки и тестов',
      languages: 'Языки',
      tests: 'Тестовые файлы'
    },
    providers: {
      title: 'Провайдеры ИИ и ключи',
      add: 'Добавить провайдера',
      empty: 'Провайдеры ещё не зарегистрированы. Добавьте один, чтобы включить реальные запуски агента.',
      encryptionUnavailable: 'Шифрование ключей ОС недоступно — ключи не могут быть сохранены',
      keySaved: 'Ключ сохранён',
      keyMissing: 'Ключ отсутствует',
      keyPlaceholder: 'Вставьте API-ключ (хранится в зашифрованном виде, больше не показывается)',
      saveKey: 'Сохранить ключ',
      deleteKey: 'Удалить ключ',
      test: 'Проверить соединение',
      testOk: 'Подключено за {{latency}} мс',
      testFail: 'Ошибка: {{message}}',
      deleteAria: 'Удалить провайдера {{name}}',
      keyNote: 'API-ключи шифруются хранилищем учётных данных операционной системы, больше не отображаются, не записываются в журналы или файлы проекта и передаются только процессу локальной службы.',
      formIncomplete: 'Требуются имя, базовый URL и модель.',
      form: { name: 'Отображаемое имя', kind: 'Формат API', model: 'Модель по умолчанию', baseUrl: 'Базовый URL', capabilities: 'Только проверенные возможности', inputPrice: 'Цена входа / 1 млн токенов', outputPrice: 'Цена выхода / 1 млн токенов' },
      source: { stored: 'зарегистрирован', env: 'окружение' }
    },
    review: {
      approvalsTitle: '{{count}} действие(й) ожидают вашего одобрения',
      approve: 'Одобрить',
      deny: 'Отклонить',
      planSummary: 'План ({{count}} шагов)',
      verificationTitle: 'Проверка сборки и тестов',
      verifyLog: '{{label}}: {{ok}}',
      noOutput: '(нет вывода)',
      reviewTitle: 'Независимая проверка diff',
      finalMessageLabel: 'Итоговый отчёт агента',
      rollback: 'Откатить рабочую область',
      rollingBack: 'Откат…',
      apply: 'Применить к проекту',
      applying: 'Применение…'
    },
    meta: { workspaceMode: 'Рабочая область: {{mode}}', iterations: 'Итерации: {{value}}', toolCalls: 'Вызовы инструментов: {{value}}' },
    history: { runtimeTag: 'Автономный запуск', toolCalls: '{{count}} вызовов инструментов' },
    risk: { high: 'Высокий риск', medium: 'Средний риск', low: 'Низкий риск' },
    decision: { approved: 'одобрено', denied: 'отклонено' },
    events: {
      started: 'Среда исполнения агента запущена',
      plan: 'План создан',
      tool_call: 'Инструмент выполнен',
      model_retry: 'Повтор вывода модели',
      repair_start: 'Попытка автоматического исправления',
      repair_tool: 'Исправляющий инструмент выполнен',
      verification: 'Проверка сборки/тестов',
      review: 'Независимая проверка',
      review_skipped: 'Проверка пропущена',
      final: 'Итоговое резюме',
      phase: 'Смена фазы',
      index: 'Индекс проекта построен',
      index_failed: 'Сбой индексации проекта',
      context: 'Контекст задачи выбран',
      context_failed: 'Сбой выбора контекста',
      approval_requested: 'Запрошено одобрение',
      approval_settled: 'Одобрение обработано',
      approval_resolved: 'Одобрение решено',
      approval_expired: 'Одобрение истекло',
      rolled_back: 'Рабочая область отменена',
      applied_to_project: 'Изменения применены к проекту'
    }
  }
}

const COMMON_ADDITIONS = {
  'en-US': { states: { pass: 'PASS', fail: 'FAIL' } },
  'zh-CN': { states: { pass: '通过', fail: '失败' } },
  'zh-TW': { states: { pass: '通過', fail: '失敗' } },
  'ja-JP': { states: { pass: '合格', fail: '失敗' } },
  'ko-KR': { states: { pass: '통과', fail: '실패' } },
  'fr-FR': { states: { pass: 'RÉUSSI', fail: 'ÉCHEC' } },
  'de-DE': { states: { pass: 'ERFOLGREICH', fail: 'FEHLGESCHLAGEN' } },
  'es-ES': { states: { pass: 'CORRECTO', fail: 'FALLO' } },
  'pt-BR': { states: { pass: 'PASSOU', fail: 'FALHOU' } },
  'ru-RU': { states: { pass: 'ПРОЙДЕНО', fail: 'СБОЙ' } }
}

const ERRORS_ADDITIONS = {
  'en-US': { agentApprovalResolve: 'The approval decision could not be saved.', agentRollback: 'The workspace could not be rolled back.', agentApply: 'The changes could not be applied to the project.', providerKeySave: 'The API key could not be stored securely.', providerSave: 'The provider could not be saved.', agentInsights: 'The project could not be analyzed.' },
  'zh-CN': { agentApprovalResolve: '审批决定保存失败。', agentRollback: '工作区回滚失败。', agentApply: '修改未能应用到项目。', providerKeySave: 'API 密钥未能安全保存。', providerSave: 'Provider 保存失败。', agentInsights: '项目分析失败。' },
  'zh-TW': { agentApprovalResolve: '核准決定儲存失敗。', agentRollback: '工作區回復失敗。', agentApply: '修改未能套用到專案。', providerKeySave: 'API 金鑰未能安全儲存。', providerSave: 'Provider 儲存失敗。', agentInsights: '專案分析失敗。' },
  'ja-JP': { agentApprovalResolve: '承認の決定を保存できませんでした。', agentRollback: 'ワークスペースを復元できませんでした。', agentApply: '変更をプロジェクトに適用できませんでした。', providerKeySave: 'API キーを安全に保存できませんでした。', providerSave: 'プロバイダーを保存できませんでした。', agentInsights: 'プロジェクトを分析できませんでした。' },
  'ko-KR': { agentApprovalResolve: '승인 결정을 저장할 수 없습니다.', agentRollback: '작업 공간을 복원할 수 없습니다.', agentApply: '변경 사항을 프로젝트에 적용할 수 없습니다.', providerKeySave: 'API 키를 안전하게 저장할 수 없습니다.', providerSave: '공급자를 저장할 수 없습니다.', agentInsights: '프로젝트를 분석할 수 없습니다.' },
  'fr-FR': { agentApprovalResolve: 'La décision d’approbation n’a pas pu être enregistrée.', agentRollback: 'L’espace de travail n’a pas pu être restauré.', agentApply: 'Les modifications n’ont pas pu être appliquées au projet.', providerKeySave: 'La clé API n’a pas pu être stockée de manière sécurisée.', providerSave: 'Le fournisseur n’a pas pu être enregistré.', agentInsights: 'Le projet n’a pas pu être analysé.' },
  'de-DE': { agentApprovalResolve: 'Die Genehmigungsentscheidung konnte nicht gespeichert werden.', agentRollback: 'Der Workspace konnte nicht zurückgesetzt werden.', agentApply: 'Die Änderungen konnten nicht auf das Projekt angewendet werden.', providerKeySave: 'Der API-Schlüssel konnte nicht sicher gespeichert werden.', providerSave: 'Der Anbieter konnte nicht gespeichert werden.', agentInsights: 'Das Projekt konnte nicht analysiert werden.' },
  'es-ES': { agentApprovalResolve: 'No se pudo guardar la decisión de aprobación.', agentRollback: 'No se pudo restaurar el espacio de trabajo.', agentApply: 'No se pudieron aplicar los cambios al proyecto.', providerKeySave: 'No se pudo guardar la clave API de forma segura.', providerSave: 'No se pudo guardar el proveedor.', agentInsights: 'No se pudo analizar el proyecto.' },
  'pt-BR': { agentApprovalResolve: 'Não foi possível salvar a decisão de aprovação.', agentRollback: 'Não foi possível reverter o espaço de trabalho.', agentApply: 'Não foi possível aplicar as alterações ao projeto.', providerKeySave: 'Não foi possível armazenar a chave de API com segurança.', providerSave: 'Não foi possível salvar o provedor.', agentInsights: 'Não foi possível analisar o projeto.' },
  'ru-RU': { agentApprovalResolve: 'Не удалось сохранить решение по одобрению.', agentRollback: 'Не удалось откатить рабочую область.', agentApply: 'Не удалось применить изменения к проекту.', providerKeySave: 'API-ключ не удалось сохранить безопасно.', providerSave: 'Не удалось сохранить провайдера.', agentInsights: 'Не удалось проанализировать проект.' }
}

const NOTIFICATIONS_ADDITIONS = {
  'en-US': {
    activity: {
      agentApprovalResolved: { label: 'Agent approval decided', detail: '{{tool}} was {{decision}}.' },
      agentRolledBack: { label: 'Agent workspace rolled back', detail: 'Isolation mode: {{mode}}. No project files were changed.' },
      agentApplied: { label: 'Agent changes applied', detail: '{{count}} file change(s) written to the project.' },
      agentApplyFailed: { label: 'Applying agent changes failed' }
    },
    toast: { agentRolledBack: 'The workspace was rolled back to its original state.', agentApplied: 'The agent changes were applied to your project.', providerSaved: 'Provider saved.' }
  },
  'zh-CN': {
    activity: {
      agentApprovalResolved: { label: 'Agent 审批已决定', detail: '{{tool}} 已被{{decision}}。' },
      agentRolledBack: { label: 'Agent 工作区已回滚', detail: '隔离模式：{{mode}}。项目文件未被修改。' },
      agentApplied: { label: 'Agent 修改已应用', detail: '{{count}} 个文件修改已写入项目。' },
      agentApplyFailed: { label: '应用 Agent 修改失败' }
    },
    toast: { agentRolledBack: '工作区已回滚到原始状态。', agentApplied: 'Agent 修改已应用到您的项目。', providerSaved: 'Provider 已保存。' }
  },
  'zh-TW': {
    activity: {
      agentApprovalResolved: { label: 'Agent 核准已決定', detail: '{{tool}} 已被{{decision}}。' },
      agentRolledBack: { label: 'Agent 工作區已回復', detail: '隔離模式：{{mode}}。專案檔案未被修改。' },
      agentApplied: { label: 'Agent 修改已套用', detail: '{{count}} 個檔案修改已寫入專案。' },
      agentApplyFailed: { label: '套用 Agent 修改失敗' }
    },
    toast: { agentRolledBack: '工作區已回復到原始狀態。', agentApplied: 'Agent 修改已套用到您的專案。', providerSaved: 'Provider 已儲存。' }
  },
  'ja-JP': {
    activity: {
      agentApprovalResolved: { label: 'エージェント承認が決定', detail: '{{tool}} が{{decision}}されました。' },
      agentRolledBack: { label: 'エージェントのワークスペースを復元', detail: '分離モード：{{mode}}。プロジェクトファイルは変更されていません。' },
      agentApplied: { label: 'エージェントの変更を適用', detail: '{{count}} 件のファイル変更をプロジェクトに書き込みました。' },
      agentApplyFailed: { label: 'エージェント変更の適用に失敗' }
    },
    toast: { agentRolledBack: 'ワークスペースは元の状態に復元されました。', agentApplied: 'エージェントの変更がプロジェクトに適用されました。', providerSaved: 'プロバイダーを保存しました。' }
  },
  'ko-KR': {
    activity: {
      agentApprovalResolved: { label: '에이전트 승인 결정됨', detail: '{{tool}}이(가) {{decision}}되었습니다.' },
      agentRolledBack: { label: '에이전트 작업 공간 복원됨', detail: '격리 모드: {{mode}}. 프로젝트 파일은 변경되지 않았습니다.' },
      agentApplied: { label: '에이전트 변경 사항 적용됨', detail: '{{count}}개 파일 변경이 프로젝트에 기록되었습니다.' },
      agentApplyFailed: { label: '에이전트 변경 적용 실패' }
    },
    toast: { agentRolledBack: '작업 공간이 원래 상태로 복원되었습니다.', agentApplied: '에이전트 변경 사항이 프로젝트에 적용되었습니다.', providerSaved: '공급자가 저장되었습니다.' }
  },
  'fr-FR': {
    activity: {
      agentApprovalResolved: { label: 'Approbation d’agent décidée', detail: '{{tool}} a été {{decision}}.' },
      agentRolledBack: { label: 'Espace de travail de l’agent restauré', detail: 'Mode d’isolation : {{mode}}. Aucun fichier de projet modifié.' },
      agentApplied: { label: 'Modifications de l’agent appliquées', detail: '{{count}} modification(s) de fichier écrite(s) dans le projet.' },
      agentApplyFailed: { label: 'Échec de l’application des modifications de l’agent' }
    },
    toast: { agentRolledBack: 'L’espace de travail a été restauré à son état d’origine.', agentApplied: 'Les modifications de l’agent ont été appliquées à votre projet.', providerSaved: 'Fournisseur enregistré.' }
  },
  'de-DE': {
    activity: {
      agentApprovalResolved: { label: 'Agent-Genehmigung entschieden', detail: '{{tool}} wurde {{decision}}.' },
      agentRolledBack: { label: 'Agent-Workspace zurückgesetzt', detail: 'Isolationsmodus: {{mode}}. Keine Projektdateien geändert.' },
      agentApplied: { label: 'Agent-Änderungen angewendet', detail: '{{count}} Dateiänderung(en) in das Projekt geschrieben.' },
      agentApplyFailed: { label: 'Anwenden der Agent-Änderungen fehlgeschlagen' }
    },
    toast: { agentRolledBack: 'Der Workspace wurde auf seinen ursprünglichen Zustand zurückgesetzt.', agentApplied: 'Die Agent-Änderungen wurden auf Ihr Projekt angewendet.', providerSaved: 'Anbieter gespeichert.' }
  },
  'es-ES': {
    activity: {
      agentApprovalResolved: { label: 'Aprobación del agente decidida', detail: '{{tool}} fue {{decision}}.' },
      agentRolledBack: { label: 'Espacio de trabajo del agente restaurado', detail: 'Modo de aislamiento: {{mode}}. No se cambiaron archivos del proyecto.' },
      agentApplied: { label: 'Cambios del agente aplicados', detail: '{{count}} cambio(s) de archivo escritos en el proyecto.' },
      agentApplyFailed: { label: 'Fallo al aplicar los cambios del agente' }
    },
    toast: { agentRolledBack: 'El espacio de trabajo volvió a su estado original.', agentApplied: 'Los cambios del agente se aplicaron a tu proyecto.', providerSaved: 'Proveedor guardado.' }
  },
  'pt-BR': {
    activity: {
      agentApprovalResolved: { label: 'Aprovação do agente decidida', detail: '{{tool}} foi {{decision}}.' },
      agentRolledBack: { label: 'Espaço de trabalho do agente revertido', detail: 'Modo de isolamento: {{mode}}. Nenhum arquivo do projeto foi alterado.' },
      agentApplied: { label: 'Alterações do agente aplicadas', detail: '{{count}} alteração(ões) de arquivo gravada(s) no projeto.' },
      agentApplyFailed: { label: 'Falha ao aplicar as alterações do agente' }
    },
    toast: { agentRolledBack: 'O espaço de trabalho voltou ao estado original.', agentApplied: 'As alterações do agente foram aplicadas ao seu projeto.', providerSaved: 'Provedor salvo.' }
  },
  'ru-RU': {
    activity: {
      agentApprovalResolved: { label: 'Одобрение агента решено', detail: '{{tool}} было {{decision}}.' },
      agentRolledBack: { label: 'Рабочая область агента отменена', detail: 'Режим изоляции: {{mode}}. Файлы проекта не изменялись.' },
      agentApplied: { label: 'Изменения агента применены', detail: '{{count}} изменение(й) файлов записано в проект.' },
      agentApplyFailed: { label: 'Не удалось применить изменения агента' }
    },
    toast: { agentRolledBack: 'Рабочая область возвращена в исходное состояние.', agentApplied: 'Изменения агента применены к вашему проекту.', providerSaved: 'Провайдер сохранён.' }
  }
}

const DECISION_TERMS = {
  'en-US': { approved: 'approved', denied: 'denied' },
  'zh-CN': { approved: '批准', denied: '拒绝' },
  'zh-TW': { approved: '核准', denied: '拒絕' },
  'ja-JP': { approved: '承認', denied: '拒否' },
  'ko-KR': { approved: '승인', denied: '거부' },
  'fr-FR': { approved: 'approuvé', denied: 'refusé' },
  'de-DE': { approved: 'genehmigt', denied: 'abgelehnt' },
  'es-ES': { approved: 'aprobada', denied: 'denegada' },
  'pt-BR': { approved: 'aprovada', denied: 'negada' },
  'ru-RU': { approved: 'одобрено', denied: 'отклонено' }
}

function deepMerge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value)
    } else {
      target[key] = value
    }
  }
  return target
}

for (const locale of LOCALES) {
  const dir = path.join(LOCALES_DIR, locale)

  const agentPath = path.join(dir, 'agent.json')
  const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'))
  deepMerge(agent, AGENT_ADDITIONS[locale])
  fs.writeFileSync(agentPath, JSON.stringify(agent, null, 2) + '\n', 'utf8')

  const commonPath = path.join(dir, 'common.json')
  const common = JSON.parse(fs.readFileSync(commonPath, 'utf8'))
  deepMerge(common, COMMON_ADDITIONS[locale])
  fs.writeFileSync(commonPath, JSON.stringify(common, null, 2) + '\n', 'utf8')

  const errorsPath = path.join(dir, 'errors.json')
  const errors = JSON.parse(fs.readFileSync(errorsPath, 'utf8'))
  deepMerge(errors, ERRORS_ADDITIONS[locale])
  fs.writeFileSync(errorsPath, JSON.stringify(errors, null, 2) + '\n', 'utf8')

  const notificationsPath = path.join(dir, 'notifications.json')
  const notifications = JSON.parse(fs.readFileSync(notificationsPath, 'utf8'))
  deepMerge(notifications, NOTIFICATIONS_ADDITIONS[locale])
  fs.writeFileSync(notificationsPath, JSON.stringify(notifications, null, 2) + '\n', 'utf8')

  console.log(`updated ${locale}`)
}
console.log('PHASE 6 i18n update complete')
