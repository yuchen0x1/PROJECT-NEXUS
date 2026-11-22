// One-shot script: add i18n keys for the ZIP baseline three-way diff, the
// agent adapter registry and the desktop assist channel (10 locales).
// Run: node scripts/add-stage3-i18n.mjs
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve('src/locales')

const baseline = {
  'en-US': {
    summary: 'ZIP baseline and three-way comparison',
    detail: 'The baseline records the upstream file manifest (path → blob hash) at capture time. A comparison classifies every path across baseline, your repository and the upstream latest state — content is never downloaded; equal hashes mean equal content.',
    capturedLabel: 'Baseline', files: '{{count}} files', none: 'No baseline captured yet',
    capture: 'Capture baseline', capturing: 'Capturing…', compare: 'Run three-way comparison', comparing: 'Comparing…',
    capturedToast: 'Baseline captured: {{files}} files from {{upstream}}.',
    comparedToast: 'Comparison done: {{conflicts}} conflict(s), {{upstream}} upstream change(s).',
    captureFailed: 'Baseline capture failed.', compareFailed: 'Comparison failed.',
    conflicts: 'Conflicts', upstreamChanges: 'Upstream changes', upstreamDeletes: 'Upstream deletions', userChanges: 'Your changes', unchanged: 'Unchanged',
    truncatedWarning: 'One of the trees was too large to list completely; the counts below may be incomplete.',
    conflictFiles: 'Conflict files ({{count}})', upstreamFiles: 'Upstream changes ({{count}})',
    moreEntries: 'Showing {{shown}} of {{total}}.',
    kind: {
      'both-modified': 'Both sides modified',
      'both-added': 'Both sides added (different content)',
      'user-deleted-upstream-present': 'You deleted it, upstream still has it',
      'user-modified-upstream-deleted': 'You modified it, upstream deleted it'
    }
  },
  'zh-CN': {
    summary: 'ZIP 基线与三方比较',
    detail: '基线在建立时记录上游文件清单（路径 → blob 哈希）。比较会把「基线 ↔ 你的仓库 ↔ 上游最新」逐路径分类——不下载任何文件内容，哈希相同即内容相同。',
    capturedLabel: '基线', files: '{{count}} 个文件', none: '尚未建立基线',
    capture: '建立基线', capturing: '正在建立…', compare: '运行三方比较', comparing: '正在比较…',
    capturedToast: '基线已建立：来自 {{upstream}} 的 {{files}} 个文件。',
    comparedToast: '比较完成：{{conflicts}} 处冲突，{{upstream}} 项上游变更。',
    captureFailed: '基线建立失败。', compareFailed: '比较失败。',
    conflicts: '冲突', upstreamChanges: '上游变更', upstreamDeletes: '上游删除', userChanges: '你的改动', unchanged: '双方未动',
    truncatedWarning: '其中一棵文件树过大未能完整列举，以下计数可能不完整。',
    conflictFiles: '冲突文件（{{count}}）', upstreamFiles: '上游变更（{{count}}）',
    moreEntries: '已显示 {{shown}} / {{total}} 项。',
    kind: {
      'both-modified': '双方都修改了',
      'both-added': '双方都新增（内容不同）',
      'user-deleted-upstream-present': '你已删除，上游仍存在',
      'user-modified-upstream-deleted': '你修改过，上游已删除'
    }
  },
  'zh-TW': {
    summary: 'ZIP 基線與三方比較',
    detail: '基線在建立時記錄上游檔案清單（路徑 → blob 雜湊）。比較會把「基線 ↔ 你的儲存庫 ↔ 上游最新」逐路徑分類——不下載任何檔案內容，雜湊相同即內容相同。',
    capturedLabel: '基線', files: '{{count}} 個檔案', none: '尚未建立基線',
    capture: '建立基線', capturing: '正在建立…', compare: '執行三方比較', comparing: '正在比較…',
    capturedToast: '基線已建立：來自 {{upstream}} 的 {{files}} 個檔案。',
    comparedToast: '比較完成：{{conflicts}} 處衝突，{{upstream}} 項上游變更。',
    captureFailed: '基線建立失敗。', compareFailed: '比較失敗。',
    conflicts: '衝突', upstreamChanges: '上游變更', upstreamDeletes: '上游刪除', userChanges: '你的改動', unchanged: '雙方未動',
    truncatedWarning: '其中一棵檔案樹過大未能完整列舉，以下計數可能不完整。',
    conflictFiles: '衝突檔案（{{count}}）', upstreamFiles: '上游變更（{{count}}）',
    moreEntries: '已顯示 {{shown}} / {{total}} 項。',
    kind: {
      'both-modified': '雙方都修改了',
      'both-added': '雙方都新增（內容不同）',
      'user-deleted-upstream-present': '你已刪除，上游仍存在',
      'user-modified-upstream-deleted': '你修改過，上游已刪除'
    }
  },
  'ja-JP': {
    summary: 'ZIP ベースラインと三方比較',
    detail: 'ベースラインは作成時点の上流ファイル一覧（パス → blob ハッシュ）を記録します。比較は「ベースライン ↔ あなたのリポジトリ ↔ 上流の最新」をパス単位で分類します。ファイル内容はダウンロードせず、ハッシュが同じなら内容も同じです。',
    capturedLabel: 'ベースライン', files: '{{count}} ファイル', none: 'ベースラインは未作成',
    capture: 'ベースラインを作成', capturing: '作成中…', compare: '三方比較を実行', comparing: '比較中…',
    capturedToast: 'ベースラインを作成しました：{{upstream}} から {{files}} ファイル。',
    comparedToast: '比較完了：衝突 {{conflicts}} 件、上流の変更 {{upstream}} 件。',
    captureFailed: 'ベースラインの作成に失敗しました。', compareFailed: '比較に失敗しました。',
    conflicts: '衝突', upstreamChanges: '上流の変更', upstreamDeletes: '上流の削除', userChanges: 'あなたの変更', unchanged: '双方未変更',
    truncatedWarning: '一部のツリーが大きく完全に列挙できなかったため、数値が不完全な場合があります。',
    conflictFiles: '衝突ファイル（{{count}}）', upstreamFiles: '上流の変更（{{count}}）',
    moreEntries: '{{total}} 件中 {{shown}} 件を表示。',
    kind: {
      'both-modified': '双方が変更',
      'both-added': '双方が追加（内容が異なる）',
      'user-deleted-upstream-present': 'あなたが削除、上流には存在',
      'user-modified-upstream-deleted': 'あなたが変更、上流では削除'
    }
  },
  'ko-KR': {
    summary: 'ZIP 베이스라인과 삼방 비교',
    detail: '베이스라인은 생성 시점의 업스트림 파일 목록(경로 → blob 해시)을 기록합니다. 비교는 "베이스라인 ↔ 내 저장소 ↔ 업스트림 최신"을 경로별로 분류하며 파일 내용을 다운로드하지 않고 해시가 같으면 내용도 같다고 판단합니다.',
    capturedLabel: '베이스라인', files: '파일 {{count}}개', none: '아직 베이스라인 없음',
    capture: '베이스라인 생성', capturing: '생성 중…', compare: '삼방 비교 실행', comparing: '비교 중…',
    capturedToast: '베이스라인 생성됨: {{upstream}}에서 {{files}}개 파일.',
    comparedToast: '비교 완료: 충돌 {{conflicts}}건, 업스트림 변경 {{upstream}}건.',
    captureFailed: '베이스라인 생성에 실패했습니다.', compareFailed: '비교에 실패했습니다.',
    conflicts: '충돌', upstreamChanges: '업스트림 변경', upstreamDeletes: '업스트림 삭제', userChanges: '내 변경', unchanged: '양쪽 모두 없음',
    truncatedWarning: '일부 트리가 너무 커서 완전히 나열되지 않았습니다. 아래 수치가 불완전할 수 있습니다.',
    conflictFiles: '충돌 파일({{count}})', upstreamFiles: '업스트림 변경({{count}})',
    moreEntries: '{{total}}건 중 {{shown}}건 표시.',
    kind: {
      'both-modified': '양쪽 모두 수정',
      'both-added': '양쪽 모두 추가(내용 다름)',
      'user-deleted-upstream-present': '삭제했으나 업스트림에 존재',
      'user-modified-upstream-deleted': '수정했으나 업스트림에서 삭제'
    }
  },
  'de-DE': {
    summary: 'ZIP-Baseline und dreiseitiger Vergleich',
    detail: 'Die Baseline erfasst zum Zeitpunkt der Aufnahme das Upstream-Dateimanifest (Pfad → Blob-Hash). Der Vergleich ordnet jeden Pfad über Baseline, Ihr Repository und den Upstream-Neustand ein — Dateiinhalte werden nie heruntergeladen; gleiche Hashes bedeuten gleichen Inhalt.',
    capturedLabel: 'Baseline', files: '{{count}} Dateien', none: 'Noch keine Baseline erfasst',
    capture: 'Baseline erfassen', capturing: 'Erfasse…', compare: 'Dreiseitigen Vergleich ausführen', comparing: 'Vergleiche…',
    capturedToast: 'Baseline erfasst: {{files}} Dateien aus {{upstream}}.',
    comparedToast: 'Vergleich fertig: {{conflicts}} Konflikt(e), {{upstream}} Upstream-Änderung(en).',
    captureFailed: 'Baseline-Erfassung fehlgeschlagen.', compareFailed: 'Vergleich fehlgeschlagen.',
    conflicts: 'Konflikte', upstreamChanges: 'Upstream-Änderungen', upstreamDeletes: 'Upstream-Löschungen', userChanges: 'Ihre Änderungen', unchanged: 'Unverändert',
    truncatedWarning: 'Ein Baum war zu groß für eine vollständige Auflistung; die Zählungen können unvollständig sein.',
    conflictFiles: 'Konfliktdateien ({{count}})', upstreamFiles: 'Upstream-Änderungen ({{count}})',
    moreEntries: '{{shown}} von {{total}} angezeigt.',
    kind: {
      'both-modified': 'Beidseitig geändert',
      'both-added': 'Beidseitig hinzugefügt (unterschiedlich)',
      'user-deleted-upstream-present': 'Von Ihnen gelöscht, upstream vorhanden',
      'user-modified-upstream-deleted': 'Von Ihnen geändert, upstream gelöscht'
    }
  },
  'es-ES': {
    summary: 'Línea base ZIP y comparación de tres vías',
    detail: 'La línea base registra el manifiesto de archivos del upstream (ruta → hash de blob) al capturarla. La comparación clasifica cada ruta entre línea base, tu repositorio y el estado más reciente del upstream — nunca se descarga contenido; hashes iguales significan contenido igual.',
    capturedLabel: 'Línea base', files: '{{count}} archivos', none: 'Aún no hay línea base',
    capture: 'Capturar línea base', capturing: 'Capturando…', compare: 'Ejecutar comparación', comparing: 'Comparando…',
    capturedToast: 'Línea base capturada: {{files}} archivos de {{upstream}}.',
    comparedToast: 'Comparación lista: {{conflicts}} conflicto(s), {{upstream}} cambio(s) del upstream.',
    captureFailed: 'La captura de la línea base falló.', compareFailed: 'La comparación falló.',
    conflicts: 'Conflictos', upstreamChanges: 'Cambios del upstream', upstreamDeletes: 'Eliminaciones del upstream', userChanges: 'Tus cambios', unchanged: 'Sin cambios',
    truncatedWarning: 'Uno de los árboles era demasiado grande para listarlos por completo; los recuentos pueden ser incompletos.',
    conflictFiles: 'Archivos en conflicto ({{count}})', upstreamFiles: 'Cambios del upstream ({{count}})',
    moreEntries: 'Mostrando {{shown}} de {{total}}.',
    kind: {
      'both-modified': 'Modificado por ambos',
      'both-added': 'Añadido por ambos (contenido distinto)',
      'user-deleted-upstream-present': 'Lo eliminaste, el upstream lo conserva',
      'user-modified-upstream-deleted': 'Lo modificaste, el upstream lo eliminó'
    }
  },
  'fr-FR': {
    summary: 'Base de référence ZIP et comparaison à trois',
    detail: 'La base de référence enregistre le manifeste des fichiers amont (chemin → hash de blob) lors de la capture. La comparaison classe chaque chemin entre la base, votre dépôt et le dernier état amont — aucun contenu n’est téléchargé ; des hachages identiques signifient un contenu identique.',
    capturedLabel: 'Base de référence', files: '{{count}} fichiers', none: 'Aucune base capturée',
    capture: 'Capturer la base', capturing: 'Capture…', compare: 'Lancer la comparaison', comparing: 'Comparaison…',
    capturedToast: 'Base capturée : {{files}} fichiers depuis {{upstream}}.',
    comparedToast: 'Comparaison terminée : {{conflicts}} conflit(s), {{upstream}} changement(s) amont.',
    captureFailed: 'Échec de la capture de la base.', compareFailed: 'Échec de la comparaison.',
    conflicts: 'Conflits', upstreamChanges: 'Changements amont', upstreamDeletes: 'Suppressions amont', userChanges: 'Vos changements', unchanged: 'Inchangés',
    truncatedWarning: 'Un arbre était trop grand pour être listé entièrement ; les comptages peuvent être incomplets.',
    conflictFiles: 'Fichiers en conflit ({{count}})', upstreamFiles: 'Changements amont ({{count}})',
    moreEntries: '{{shown}} sur {{total}} affichés.',
    kind: {
      'both-modified': 'Modifié des deux côtés',
      'both-added': 'Ajouté des deux côtés (contenus différents)',
      'user-deleted-upstream-present': 'Supprimé de votre côté, présent amont',
      'user-modified-upstream-deleted': 'Modifié de votre côté, supprimé amont'
    }
  },
  'pt-BR': {
    summary: 'Linha de base ZIP e comparação de três vias',
    detail: 'A linha de base registra o manifesto de arquivos do upstream (caminho → hash de blob) na captura. A comparação classifica cada caminho entre linha de base, seu repositório e o estado mais recente do upstream — nenhum conteúdo é baixado; hashes iguais significam conteúdo igual.',
    capturedLabel: 'Linha de base', files: '{{count}} arquivos', none: 'Nenhuma linha de base capturada',
    capture: 'Capturar linha de base', capturing: 'Capturando…', compare: 'Executar comparação', comparing: 'Comparando…',
    capturedToast: 'Linha de base capturada: {{files}} arquivos de {{upstream}}.',
    comparedToast: 'Comparação concluída: {{conflicts}} conflito(s), {{upstream}} mudança(s) do upstream.',
    captureFailed: 'Falha ao capturar a linha de base.', compareFailed: 'Falha na comparação.',
    conflicts: 'Conflitos', upstreamChanges: 'Mudanças do upstream', upstreamDeletes: 'Exclusões do upstream', userChanges: 'Suas mudanças', unchanged: 'Inalterados',
    truncatedWarning: 'Uma das árvores era grande demais para listar completamente; as contagens podem estar incompletas.',
    conflictFiles: 'Arquivos em conflito ({{count}})', upstreamFiles: 'Mudanças do upstream ({{count}})',
    moreEntries: 'Mostrando {{shown}} de {{total}}.',
    kind: {
      'both-modified': 'Modificado por ambos',
      'both-added': 'Adicionado por ambos (conteúdo diferente)',
      'user-deleted-upstream-present': 'Você excluiu, o upstream mantém',
      'user-modified-upstream-deleted': 'Você modificou, o upstream excluiu'
    }
  },
  'ru-RU': {
    summary: 'Базовая линия ZIP и трёхстороннее сравнение',
    detail: 'Базовая линия фиксирует манифест файлов исходного репозитория (путь → хеш blob) на момент захвата. Сравнение классифицирует каждый путь между базой, вашим репозиторием и последним состоянием источника — содержимое не скачивается; одинаковые хеши означают одинаковое содержимое.',
    capturedLabel: 'Базовая линия', files: 'файлов: {{count}}', none: 'Базовая линия ещё не создана',
    capture: 'Захватить базовую линию', capturing: 'Захват…', compare: 'Запустить сравнение', comparing: 'Сравнение…',
    capturedToast: 'Базовая линия захвачена: {{files}} файлов из {{upstream}}.',
    comparedToast: 'Сравнение завершено: конфликтов {{conflicts}}, изменений источника {{upstream}}.',
    captureFailed: 'Не удалось захватить базовую линию.', compareFailed: 'Ошибка сравнения.',
    conflicts: 'Конфликты', upstreamChanges: 'Изменения источника', upstreamDeletes: 'Удаления источника', userChanges: 'Ваши изменения', unchanged: 'Без изменений',
    truncatedWarning: 'Одно из деревьев слишком велико для полного перечисления; счётчики могут быть неполными.',
    conflictFiles: 'Файлы с конфликтами ({{count}})', upstreamFiles: 'Изменения источника ({{count}})',
    moreEntries: 'Показано {{shown}} из {{total}}.',
    kind: {
      'both-modified': 'Изменено обеими сторонами',
      'both-added': 'Добавлено обеими сторонами (разное содержимое)',
      'user-deleted-upstream-present': 'Вы удалили, в источнике осталось',
      'user-modified-upstream-deleted': 'Вы изменили, в источнике удалено'
    }
  }
}

const bridgeAdd = {
  'en-US': {
    desktopState: 'Desktop app {{name}} {{version}} · {{state}}',
    desktopRunning: 'running', desktopStopped: 'not running',
    desktopLaunch: 'Launch', desktopLaunching: 'Launching…',
    revealWorkspace: 'Reveal workspace', revealing: 'Opening…'
  },
  'zh-CN': {
    desktopState: '桌面端 {{name}} {{version}} · {{state}}',
    desktopRunning: '运行中', desktopStopped: '未运行',
    desktopLaunch: '启动', desktopLaunching: '正在启动…',
    revealWorkspace: '打开工作区', revealing: '正在打开…'
  },
  'zh-TW': {
    desktopState: '桌面端 {{name}} {{version}} · {{state}}',
    desktopRunning: '執行中', desktopStopped: '未執行',
    desktopLaunch: '啟動', desktopLaunching: '正在啟動…',
    revealWorkspace: '開啟工作區', revealing: '正在開啟…'
  },
  'ja-JP': {
    desktopState: 'デスクトップ版 {{name}} {{version}} · {{state}}',
    desktopRunning: '実行中', desktopStopped: '未実行',
    desktopLaunch: '起動', desktopLaunching: '起動中…',
    revealWorkspace: 'ワークスペースを表示', revealing: '開いています…'
  },
  'ko-KR': {
    desktopState: '데스크톱 앱 {{name}} {{version}} · {{state}}',
    desktopRunning: '실행 중', desktopStopped: '실행 안 함',
    desktopLaunch: '실행', desktopLaunching: '실행 중…',
    revealWorkspace: '작업 공간 열기', revealing: '여는 중…'
  },
  'de-DE': {
    desktopState: 'Desktop-App {{name}} {{version}} · {{state}}',
    desktopRunning: 'läuft', desktopStopped: 'nicht läuft',
    desktopLaunch: 'Starten', desktopLaunching: 'Starte…',
    revealWorkspace: 'Arbeitsbereich anzeigen', revealing: 'Öffne…'
  },
  'es-ES': {
    desktopState: 'Aplicación de escritorio {{name}} {{version}} · {{state}}',
    desktopRunning: 'en ejecución', desktopStopped: 'sin ejecutar',
    desktopLaunch: 'Iniciar', desktopLaunching: 'Iniciando…',
    revealWorkspace: 'Abrir espacio de trabajo', revealing: 'Abriendo…'
  },
  'fr-FR': {
    desktopState: 'Application de bureau {{name}} {{version}} · {{state}}',
    desktopRunning: 'en cours', desktopStopped: 'arrêtée',
    desktopLaunch: 'Lancer', desktopLaunching: 'Lancement…',
    revealWorkspace: 'Afficher l’espace de travail', revealing: 'Ouverture…'
  },
  'pt-BR': {
    desktopState: 'Aplicativo de desktop {{name}} {{version}} · {{state}}',
    desktopRunning: 'em execução', desktopStopped: 'não está em execução',
    desktopLaunch: 'Iniciar', desktopLaunching: 'Iniciando…',
    revealWorkspace: 'Abrir espaço de trabalho', revealing: 'Abrindo…'
  },
  'ru-RU': {
    desktopState: 'Настольное приложение {{name}} {{version}} · {{state}}',
    desktopRunning: 'запущено', desktopStopped: 'не запущено',
    desktopLaunch: 'Запустить', desktopLaunching: 'Запуск…',
    revealWorkspace: 'Показать рабочую область', revealing: 'Открываю…'
  }
}

const errors = {
  'en-US': { desktop: 'Could not launch the desktop application.', reveal: 'Could not open the workspace folder.' },
  'zh-CN': { desktop: '无法启动桌面应用。', reveal: '无法打开工作区文件夹。' },
  'zh-TW': { desktop: '無法啟動桌面應用程式。', reveal: '無法開啟工作區資料夾。' },
  'ja-JP': { desktop: 'デスクトップアプリを起動できませんでした。', reveal: 'ワークスペースフォルダーを開けませんでした。' },
  'ko-KR': { desktop: '데스크톱 앱을 실행하지 못했습니다.', reveal: '작업 공간 폴더를 열지 못했습니다.' },
  'de-DE': { desktop: 'Die Desktop-App konnte nicht gestartet werden.', reveal: 'Der Arbeitsbereich-Ordner konnte nicht geöffnet werden.' },
  'es-ES': { desktop: 'No se pudo iniciar la aplicación de escritorio.', reveal: 'No se pudo abrir la carpeta del espacio de trabajo.' },
  'fr-FR': { desktop: 'Impossible de lancer l’application de bureau.', reveal: 'Impossible d’ouvrir le dossier de l’espace de travail.' },
  'pt-BR': { desktop: 'Não foi possível iniciar o aplicativo de desktop.', reveal: 'Não foi possível abrir a pasta do espaço de trabalho.' },
  'ru-RU': { desktop: 'Не удалось запустить настольное приложение.', reveal: 'Не удалось открыть папку рабочей области.' }
}

const activity = {
  'en-US': { launched: 'Desktop application launched', revealed: 'Workspace opened in Explorer' },
  'zh-CN': { launched: '桌面应用已启动', revealed: '已在资源管理器中打开工作区' },
  'zh-TW': { launched: '桌面應用程式已啟動', revealed: '已在檔案總管中開啟工作區' },
  'ja-JP': { launched: 'デスクトップアプリを起動しました', revealed: 'ワークスペースをエクスプローラーで開きました' },
  'ko-KR': { launched: '데스크톱 앱이 실행되었습니다', revealed: '탐색기에서 작업 공간을 열었습니다' },
  'de-DE': { launched: 'Desktop-App gestartet', revealed: 'Arbeitsbereich im Explorer geöffnet' },
  'es-ES': { launched: 'Aplicación de escritorio iniciada', revealed: 'Espacio de trabajo abierto en el explorador' },
  'fr-FR': { launched: 'Application de bureau lancée', revealed: 'Espace de travail ouvert dans l’Explorateur' },
  'pt-BR': { launched: 'Aplicativo de desktop iniciado', revealed: 'Espaço de trabalho aberto no Explorador' },
  'ru-RU': { launched: 'Настольное приложение запущено', revealed: 'Рабочая область открыта в Проводнике' }
}

for (const locale of Object.keys(baseline)) {
  // git.json → upstream.baseline
  {
    const file = path.join(root, locale, 'git.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data.upstream.baseline) data.upstream.baseline = baseline[locale]
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  }
  // agent.json → bridge additions + review reveal
  {
    const file = path.join(root, locale, 'agent.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const add = bridgeAdd[locale]
    for (const [key, value] of Object.entries(add)) {
      if (key === 'revealWorkspace' || key === 'revealing') continue
      if (!data.bridge[key]) data.bridge[key] = value
    }
    if (!data.review.revealWorkspace) data.review.revealWorkspace = add.revealWorkspace
    if (!data.review.revealing) data.review.revealing = add.revealing
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  }
  // errors.json
  {
    const file = path.join(root, locale, 'errors.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data.agentDesktopLaunch) data.agentDesktopLaunch = errors[locale].desktop
    if (!data.agentWorkspaceReveal) data.agentWorkspaceReveal = errors[locale].reveal
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  }
  // notifications.json
  {
    const file = path.join(root, locale, 'notifications.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!data.activity.agentDesktopLaunched) data.activity.agentDesktopLaunched = { label: activity[locale].launched }
    if (!data.activity.agentWorkspaceRevealed) data.activity.agentWorkspaceRevealed = { label: activity[locale].revealed }
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  }
  console.log(`${locale}: ok`)
}
