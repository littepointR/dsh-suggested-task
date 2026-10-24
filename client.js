/**
 * Client half of `@local/dsh-suggested-task`.
 *
 * Contributes four coordinated surfaces to the DSH Web UI:
 *   1. `conversation.chat.turnTail` — Claude Desktop–style "Suggested tasks"
 *      card beneath each completed turn, with individual "Start" buttons, a
 *      "Start all" batch button, worktree branch badges, live child-session
 *      status indicators, and one-click "Open sub-session" navigation.
 *   2. `conversation.session.header.actions` — Parent/child lineage pills in
 *      the conversation header: a clickable "↖ Parent session" breadcrumb +
 *      worktree branch pill when viewing a child task session, and a live
 *      "↳ N sub-sessions" switcher dropdown when viewing a parent session.
 *   3. `sidebar.session.row.leading` & `sidebar.session.row.hover` (plus
 *      dynamic `--dsh-workspace-indent` tree styling on child session rows) —
 *      visual indentation, tree-branch icon, and hover details in the left
 *      sidebar so child sessions are immediately recognizable under their
 *      parent session.
 *   4. `conversation.chat.commandview` (`key: 'tasks'`) — handles `/tasks`
 *      command rows cleanly in the transcript.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-suggested-task',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'plugin.suggested-task'
    const PROJECTION = 'suggestedTasks'
    const COMMAND = 'tasks'
    const COMMAND_PAYLOAD_PREFIX = 'DSH_SUGGESTED_TASKS_V1:'

    const zh = {
      title: '建议后续任务',
      subtitle: '独立 Git 工作树 · 子会话',
      startAll: '全部开始 ({count})',
      startingAll: '正在启动全部…',
      allStarted: '已全部在子会话中启动',
      start: '开始',
      starting: '创建工作树…',
      openChild: '查看子会话',
      statusRunning: '进行中',
      statusDone: '已就绪',
      parentBadge: '父会话：{title}',
      parentFallback: '返回父会话',
      subsessionTag: '子会话',
      childrenCount: '{count} 个子会话',
      childrenRunning: '{running} 进行中',
      hoverSubsessionOf: '子会话自：{parent}',
      hoverWorktree: '工作树分支：{branch}',
      hoverChildrenTitle: '派生工作树子会话 ({count})',
      commandPending: '正在生成后续任务建议…',
      commandFailed: '后续任务操作失败',
      regenerate: '重新生成',
      regenerating: '生成中…',
    }

    const en = {
      title: 'Suggested follow-up tasks',
      subtitle: 'Isolated Git worktree · Sub-session',
      startAll: 'Start all ({count})',
      startingAll: 'Starting all…',
      allStarted: 'All started in sub-sessions',
      start: 'Start',
      starting: 'Creating worktree…',
      openChild: 'Open sub-session',
      statusRunning: 'Running',
      statusDone: 'Ready',
      parentBadge: 'Parent: {title}',
      parentFallback: 'Back to parent',
      subsessionTag: 'Sub-session',
      childrenCount: '{count} sub-sessions',
      childrenRunning: '{running} running',
      hoverSubsessionOf: 'Sub-session of: {parent}',
      hoverWorktree: 'Worktree branch: {branch}',
      hoverChildrenTitle: 'Worktree sub-sessions ({count})',
      commandPending: 'Generating follow-up task suggestions…',
      commandFailed: 'Suggested task action failed',
      regenerate: 'Regenerate',
      regenerating: 'Generating…',
    }

    // ---------------------------------------------------------------- styles
    const CARD_STYLE = {
      marginTop: '10px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-border-default, rgba(128, 128, 128, 0.22))',
      background: 'var(--dsw-alias-bg-layer-1, rgba(128, 128, 128, 0.05))',
      overflow: 'hidden',
      fontSize: '13px',
      lineHeight: 1.45,
      color: 'var(--dsw-alias-text-primary, inherit)',
    }

    const CARD_HEADER_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '10px',
      padding: '9px 12px',
      borderBottom: '1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.14))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.04))',
      flexWrap: 'wrap',
    }

    const HEADER_LEFT_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      minWidth: 0,
      flexWrap: 'wrap',
    }

    const HEADER_TITLE_STYLE = {
      fontWeight: 600,
      fontSize: '12.5px',
      color: 'var(--dsw-alias-text-primary, inherit)',
    }

    const HEADER_SUBTITLE_STYLE = {
      fontSize: '11px',
      padding: '1px 6px',
      borderRadius: '999px',
      background: 'rgba(59, 130, 246, 0.12)',
      color: 'var(--dsw-alias-brand-text, #3b82f6)',
      fontWeight: 500,
    }

    const HEADER_ACTIONS_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
    }

    const START_ALL_BTN_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '4px 10px',
      borderRadius: '7px',
      border: '1px solid rgba(59, 130, 246, 0.35)',
      background: 'var(--dsw-alias-brand-primary, #2563eb)',
      color: '#ffffff',
      fontSize: '11.5px',
      fontWeight: 600,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const SECONDARY_BTN_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '4px 9px',
      borderRadius: '7px',
      border: '1px solid var(--dsw-alias-border-default, rgba(128, 128, 128, 0.25))',
      background: 'var(--dsw-alias-bg-surface, transparent)',
      color: 'var(--dsw-alias-text-primary, inherit)',
      fontSize: '11.5px',
      fontWeight: 500,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const OPEN_CHILD_BTN_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 9px',
      borderRadius: '7px',
      border: '1px solid rgba(59, 130, 246, 0.32)',
      background: 'rgba(59, 130, 246, 0.09)',
      color: 'var(--dsw-alias-brand-text, #3b82f6)',
      fontSize: '11.5px',
      fontWeight: 600,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const TASK_LIST_STYLE = {
      display: 'flex',
      flexDirection: 'column',
    }

    const TASK_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '10px 12px',
      borderTop: '1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.1))',
    }

    const TASK_MAIN_STYLE = {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '9px',
      minWidth: 0,
      flex: 1,
    }

    const TASK_INDEX_BADGE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '20px',
      height: '20px',
      borderRadius: '6px',
      background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
      color: 'var(--dsw-alias-text-secondary, inherit)',
      fontSize: '11px',
      fontWeight: 600,
      flexShrink: 0,
      marginTop: '1px',
    }

    const TASK_BODY_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      minWidth: 0,
      flex: 1,
    }

    const TASK_TITLE_ROW_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      flexWrap: 'wrap',
    }

    const TASK_TITLE_STYLE = {
      fontWeight: 600,
      fontSize: '13px',
      color: 'var(--dsw-alias-text-primary, inherit)',
    }

    const BRANCH_CHIP_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '3px',
      padding: '1px 6px',
      borderRadius: '5px',
      background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.12))',
      color: 'var(--dsw-alias-text-tertiary, inherit)',
      fontFamily: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
      fontSize: '11px',
      maxWidth: '220px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    const TASK_DESC_STYLE = {
      fontSize: '12px',
      color: 'var(--dsw-alias-text-secondary, inherit)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    const TASK_RIGHT_STYLE = {
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      flexShrink: 0,
    }

    const STATUS_PILL_RUNNING_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '2px 7px',
      borderRadius: '999px',
      background: 'rgba(59, 130, 246, 0.14)',
      color: 'var(--dsw-alias-brand-text, #3b82f6)',
      fontSize: '11px',
      fontWeight: 600,
    }

    const STATUS_PILL_DONE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      padding: '2px 7px',
      borderRadius: '999px',
      background: 'rgba(16, 185, 129, 0.14)',
      color: '#10b981',
      fontSize: '11px',
      fontWeight: 600,
    }

    const HEADER_PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '2px 8px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-default, rgba(128, 128, 128, 0.24))',
      background: 'var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.08))',
      color: 'var(--dsw-alias-text-secondary, inherit)',
      fontSize: '11.5px',
      fontWeight: 500,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    const ERROR_BANNER_STYLE = {
      padding: '7px 12px',
      borderTop: '1px solid rgba(239, 68, 68, 0.24)',
      background: 'rgba(239, 68, 68, 0.08)',
      color: 'var(--dsw-alias-state-error-primary, #ef4444)',
      fontSize: '12px',
    }

    // ---------------------------------------------------------------- state & helpers
    /**
     * Local optimistic store of started/generated tasks and child session lineage
     * so UI interactions update immediately even before a projection round-trip.
     */
    const localStore = {
      turnsBySession: new Map(),
      childBySessionId: new Map(),
      listeners: new Set(),
      notify() {
        for (const listener of this.listeners) {
          try {
            listener()
          } catch {
            // Ignore listener errors.
          }
        }
      },
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      recordStarted(parentSessionId, turn, startedRecords) {
        if (typeof parentSessionId !== 'string' || parentSessionId === '' || !Array.isArray(startedRecords)) return
        let sessionTurns = this.turnsBySession.get(parentSessionId)
        if (sessionTurns === undefined) {
          sessionTurns = new Map()
          this.turnsBySession.set(parentSessionId, sessionTurns)
        }
        const turnKey = String(turn)
        const prev = sessionTurns.get(turnKey) ?? { started: {} }
        const nextStarted = { ...prev.started }
        for (const item of startedRecords) {
          if (item && typeof item.taskId === 'string' && typeof item.sessionId === 'string') {
            nextStarted[item.taskId] = item
            this.childBySessionId.set(item.sessionId, {
              parentSessionId,
              parentTurn: turn,
              taskId: item.taskId,
              title: item.title ?? '',
              branch: item.branch ?? '',
              worktreePath: item.worktreePath ?? '',
            })
          }
        }
        sessionTurns.set(turnKey, { ...prev, started: nextStarted })
        this.notify()
      },
      recordGenerated(parentSessionId, turn, entry) {
        if (typeof parentSessionId !== 'string' || parentSessionId === '') return
        let sessionTurns = this.turnsBySession.get(parentSessionId)
        if (sessionTurns === undefined) {
          sessionTurns = new Map()
          this.turnsBySession.set(parentSessionId, sessionTurns)
        }
        const turnKey = String(turn)
        const prev = sessionTurns.get(turnKey) ?? { started: {} }
        sessionTurns.set(turnKey, {
          ...prev,
          ...entry,
          started: { ...prev.started, ...(entry.started ?? {}) },
        })
        this.notify()
      },
    }

    /** Decode a `DSH_SUGGESTED_TASKS_V1:` command result string. */
    function parseCommandPayload(text) {
      if (typeof text !== 'string') return undefined
      const trimmed = text.trim()
      if (!trimmed.startsWith(COMMAND_PAYLOAD_PREFIX)) return undefined
      try {
        const parsed = JSON.parse(trimmed.slice(COMMAND_PAYLOAD_PREFIX.length))
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined
      } catch {
        return undefined
      }
    }

    /** Extract the numeric turn id from a `conversation.chat.turnTail` turn prop. */
    function turnNumberOf(turn) {
      if (typeof turn === 'number' && Number.isInteger(turn)) return turn
      if (turn === null || typeof turn !== 'object') return undefined
      for (const key of ['turn', 'number', 'index', 'id']) {
        if (typeof turn[key] === 'number' && Number.isInteger(turn[key])) return turn[key]
      }
      return undefined
    }

    /** Format a localized string with `{key}` placeholders. */
    function formatCopy(t, key, vars, fallback) {
      const raw = typeof t === 'function' ? t(key, vars) : undefined
      const template = typeof raw === 'string' && raw !== key ? raw : (fallback ?? en[key] ?? key)
      if (!vars || typeof template !== 'string') return template
      return template.replace(/\{(\w+)\}/gu, (_, name) => String(vars[name] ?? ''))
    }

    /**
     * Build a complete parent<->child lineage index from the current sessions
     * snapshot plus `localStore`.
     */
    function deriveLineageIndex(snapshot) {
      const childBySessionId = new Map(localStore.childBySessionId)
      const childrenByParentId = new Map()

      const addLink = (parentSessionId, childSessionId, info) => {
        if (
          typeof parentSessionId !== 'string'
          || parentSessionId === ''
          || typeof childSessionId !== 'string'
          || childSessionId === ''
        ) {
          return
        }
        const merged = {
          parentSessionId,
          sessionId: childSessionId,
          parentTurn: info.parentTurn ?? info.turn ?? 0,
          taskId: info.taskId ?? '',
          title: info.title ?? '',
          branch: info.branch ?? '',
          worktreePath: info.worktreePath ?? '',
          startedAt: info.startedAt ?? 0,
        }
        childBySessionId.set(childSessionId, merged)
        let list = childrenByParentId.get(parentSessionId)
        if (list === undefined) {
          list = []
          childrenByParentId.set(parentSessionId, list)
        }
        if (!list.some((item) => item.sessionId === childSessionId)) {
          list.push(merged)
        }
      }

      for (const [childId, info] of localStore.childBySessionId.entries()) {
        addLink(info.parentSessionId, childId, info)
      }

      const inspectProjection = (sessionId, proj) => {
        if (!proj || typeof proj !== 'object') return
        if (proj.childOf && typeof proj.childOf === 'object' && typeof proj.childOf.parentSessionId === 'string') {
          addLink(proj.childOf.parentSessionId, sessionId, proj.childOf)
        }
        if (proj.turns && typeof proj.turns === 'object') {
          for (const turnEntry of Object.values(proj.turns)) {
            if (!turnEntry || typeof turnEntry !== 'object' || !turnEntry.started) continue
            for (const record of Object.values(turnEntry.started)) {
              if (record && typeof record.sessionId === 'string') {
                addLink(sessionId, record.sessionId, {
                  ...record,
                  parentTurn: turnEntry.turn,
                })
              }
            }
          }
        }
      }

      const byId = snapshot?.byId ?? {}
      for (const [sessionId, summary] of Object.entries(byId)) {
        inspectProjection(sessionId, summary?.projectionValues?.[PROJECTION])
      }
      const projectionsBySession = snapshot?.projectionsBySession ?? {}
      for (const [sessionId, entry] of Object.entries(projectionsBySession)) {
        inspectProjection(sessionId, entry?.values?.[PROJECTION])
      }

      return { childBySessionId, childrenByParentId }
    }

    /** Small branch/sub-session SVG icon. */
    function BranchIcon(props) {
      const size = props?.size ?? 13
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flexShrink: 0 },
        },
        h('circle', { cx: '4.5', cy: '3.5', r: '1.75', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('circle', { cx: '4.5', cy: '12.5', r: '1.75', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('circle', { cx: '11.5', cy: '8.5', r: '1.75', stroke: 'currentColor', strokeWidth: '1.4' }),
        h('path', {
          d: 'M4.5 5.25V10.75M4.5 5.5C4.5 7.2 6 8.5 8 8.5H9.75',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
        }),
      )
    }

    /** Sub-session corner arrow icon (`↳`). */
    function SubsessionTreeIcon(props) {
      const size = props?.size ?? 14
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          style: { flexShrink: 0, color: 'var(--dsw-alias-brand-text, #3b82f6)' },
        },
        h('path', {
          d: 'M4.5 2.5V8.5C4.5 9.60457 5.39543 10.5 6.5 10.5H12.5M12.5 10.5L9.75 7.75M12.5 10.5L9.75 13.25',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // ---------------------------------------------------------------- 1. Turn-tail Suggested Tasks card
    const inflightProjectionReads = new Map()

    function fetchTurnProjection(sessionId, loadProjection) {
      if (typeof loadProjection !== 'function' || typeof sessionId !== 'string' || sessionId === '') {
        return Promise.resolve(undefined)
      }
      const existing = inflightProjectionReads.get(sessionId)
      if (existing !== undefined) return existing
      const promise = Promise.resolve()
        .then(() => loadProjection(sessionId))
        .then((res) => res?.values?.[PROJECTION] ?? res?.value?.values?.[PROJECTION])
        .catch(() => undefined)
        .finally(() => {
          inflightProjectionReads.delete(sessionId)
        })
      inflightProjectionReads.set(sessionId, promise)
      return promise
    }

    /**
     * Render the Claude Desktop–style Suggested Tasks card beneath a completed turn.
     */
    function SuggestedTasksTurnCard(props) {
      const turnNumber = turnNumberOf(props.turn)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const useProjection = props.useProjection
      const useSessions = props.useSessions
      const loadProjection = props.loadProjection
      const executeCommand = props.executeCommand
      const openSession = props.openSession
      const t = props.t

      const liveProjection = typeof useProjection === 'function'
        ? useProjection(PROJECTION, (value) => value)
        : undefined
      const sessionsSnapshot = typeof useSessions === 'function'
        ? useSessions((state) => state)
        : undefined

      const [fallbackProjection, setFallbackProjection] = React.useState(undefined)
      const [startingTaskIds, setStartingTaskIds] = React.useState({})
      const [startingAll, setStartingAll] = React.useState(false)
      const [regenerating, setRegenerating] = React.useState(false)
      const [errorText, setErrorText] = React.useState('')
      const [, forceUpdate] = React.useState(0)
      const attemptedRead = React.useRef(false)

      React.useEffect(() => localStore.subscribe(() => forceUpdate((n) => n + 1)), [])

      const projection = liveProjection ?? fallbackProjection
      const turnKey = turnNumber !== undefined ? String(turnNumber) : ''
      const localTurn = localStore.turnsBySession.get(sessionId)?.get(turnKey)
      const rawEntry = (turnKey !== '' ? projection?.turns?.[turnKey] : undefined) ?? localTurn
      const tasks = Array.isArray(rawEntry?.tasks) ? rawEntry.tasks : []

      React.useEffect(() => {
        if (tasks.length > 0 || attemptedRead.current || typeof loadProjection !== 'function' || sessionId === '') {
          return undefined
        }
        attemptedRead.current = true
        let active = true
        fetchTurnProjection(sessionId, loadProjection).then((loaded) => {
          if (active && loaded !== undefined) setFallbackProjection(loaded)
        })
        return () => {
          active = false
        }
      }, [tasks.length, loadProjection, sessionId])

      if (turnNumber === undefined || tasks.length === 0) return null

      // Merge started task records from both the Host projection and optimistic local state.
      const mergedStarted = {
        ...(rawEntry?.started ?? {}),
        ...(localTurn?.started ?? {}),
      }

      const unstartedTasks = tasks.filter((task) => !mergedStarted[task.id]?.sessionId)

      const handleStartOne = async (task) => {
        if (typeof executeCommand !== 'function' || sessionId === '') return
        setErrorText('')
        setStartingTaskIds((prev) => ({ ...prev, [task.id]: true }))
        try {
          const res = await executeCommand(sessionId, `/${COMMAND} start ${turnNumber} ${task.id}`)
          if (res?.ok === false) {
            setErrorText(res.error?.message ?? formatCopy(t, 'commandFailed'))
            return
          }
          const outcome = res?.value?.result ?? res?.result
          if (outcome?.kind === 'error') {
            setErrorText(outcome.text || formatCopy(t, 'commandFailed'))
            return
          }
          const payload = parseCommandPayload(outcome?.text)
          if (payload?.action === 'started' && Array.isArray(payload.started)) {
            localStore.recordStarted(sessionId, turnNumber, payload.started)
          }
        } catch (error) {
          setErrorText(error instanceof Error ? error.message : String(error))
        } finally {
          setStartingTaskIds((prev) => {
            const next = { ...prev }
            delete next[task.id]
            return next
          })
        }
      }

      const handleStartAll = async () => {
        if (typeof executeCommand !== 'function' || sessionId === '' || unstartedTasks.length === 0) return
        setErrorText('')
        setStartingAll(true)
        try {
          const res = await executeCommand(sessionId, `/${COMMAND} start-all ${turnNumber}`)
          if (res?.ok === false) {
            setErrorText(res.error?.message ?? formatCopy(t, 'commandFailed'))
            return
          }
          const outcome = res?.value?.result ?? res?.result
          if (outcome?.kind === 'error') {
            setErrorText(outcome.text || formatCopy(t, 'commandFailed'))
            return
          }
          const payload = parseCommandPayload(outcome?.text)
          if (payload?.action === 'started' && Array.isArray(payload.started)) {
            localStore.recordStarted(sessionId, turnNumber, payload.started)
          }
        } catch (error) {
          setErrorText(error instanceof Error ? error.message : String(error))
        } finally {
          setStartingAll(false)
        }
      }

      const handleRegenerate = async () => {
        if (typeof executeCommand !== 'function' || sessionId === '' || regenerating) return
        setErrorText('')
        setRegenerating(true)
        try {
          const res = await executeCommand(sessionId, `/${COMMAND} generate ${turnNumber}`)
          const outcome = res?.value?.result ?? res?.result
          if (outcome?.kind === 'error') {
            setErrorText(outcome.text || formatCopy(t, 'commandFailed'))
            return
          }
          const payload = parseCommandPayload(outcome?.text)
          if (payload?.action === 'generated' && Array.isArray(payload.tasks)) {
            localStore.recordGenerated(sessionId, turnNumber, payload)
          }
        } catch (error) {
          setErrorText(error instanceof Error ? error.message : String(error))
        } finally {
          setRegenerating(false)
        }
      }

      return h(
        'section',
        {
          'data-dsh-suggested-tasks': '',
          'data-turn': String(turnNumber),
          style: CARD_STYLE,
        },
        // Header
        h(
          'div',
          { style: CARD_HEADER_STYLE },
          h(
            'div',
            { style: HEADER_LEFT_STYLE },
            h(BranchIcon, { size: 14 }),
            h('span', { style: HEADER_TITLE_STYLE }, formatCopy(t, 'title')),
            h('span', { style: HEADER_SUBTITLE_STYLE }, formatCopy(t, 'subtitle')),
          ),
          h(
            'div',
            { style: HEADER_ACTIONS_STYLE },
            unstartedTasks.length > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    'data-dsh-suggested-task-start-all': '',
                    disabled: startingAll,
                    onClick: handleStartAll,
                    style: {
                      ...START_ALL_BTN_STYLE,
                      opacity: startingAll ? 0.65 : 1,
                    },
                  },
                  startingAll
                    ? formatCopy(t, 'startingAll')
                    : formatCopy(t, 'startAll', { count: unstartedTasks.length }),
                )
              : h(
                  'span',
                  { style: STATUS_PILL_DONE_STYLE },
                  '✓ ',
                  formatCopy(t, 'allStarted'),
                ),
            h(
              'button',
              {
                type: 'button',
                'data-dsh-suggested-task-regenerate': '',
                disabled: regenerating || startingAll,
                onClick: handleRegenerate,
                style: {
                  ...SECONDARY_BTN_STYLE,
                  opacity: regenerating ? 0.6 : 1,
                },
              },
              regenerating ? formatCopy(t, 'regenerating') : formatCopy(t, 'regenerate'),
            ),
          ),
        ),
        // Task rows
        h(
          'div',
          { style: TASK_LIST_STYLE },
          ...tasks.map((task, idx) => {
            const startedInfo = mergedStarted[task.id]
            const isStarted = typeof startedInfo?.sessionId === 'string' && startedInfo.sessionId !== ''
            const isStarting = Boolean(startingTaskIds[task.id]) || (startingAll && !isStarted)
            const childSummary = isStarted ? sessionsSnapshot?.byId?.[startedInfo.sessionId] : undefined
            const isChildRunning = Boolean(childSummary?.running)
            const branchLabel = (isStarted && startedInfo.branch) ? startedInfo.branch : task.branch

            return h(
              'div',
              {
                key: task.id ?? String(idx),
                'data-dsh-suggested-task-item': task.id,
                'data-started': isStarted ? 'true' : 'false',
                style: TASK_ROW_STYLE,
              },
              h(
                'div',
                { style: TASK_MAIN_STYLE },
                h(
                  'span',
                  {
                    style: isStarted
                      ? {
                          ...TASK_INDEX_BADGE_STYLE,
                          background: isChildRunning ? 'rgba(59, 130, 246, 0.16)' : 'rgba(16, 185, 129, 0.16)',
                          color: isChildRunning ? '#3b82f6' : '#10b981',
                        }
                      : TASK_INDEX_BADGE_STYLE,
                  },
                  isStarted ? (isChildRunning ? '●' : '✓') : String(idx + 1),
                ),
                h(
                  'div',
                  { style: TASK_BODY_STYLE },
                  h(
                    'div',
                    { style: TASK_TITLE_ROW_STYLE },
                    h('span', { style: TASK_TITLE_STYLE }, task.title),
                    branchLabel
                      ? h(
                          'span',
                          {
                            style: BRANCH_CHIP_STYLE,
                            title: startedInfo?.worktreePath || branchLabel,
                          },
                          '⎇ ',
                          branchLabel,
                        )
                      : null,
                  ),
                  task.description
                    ? h('div', { style: TASK_DESC_STYLE }, task.description)
                    : null,
                ),
              ),
              h(
                'div',
                { style: TASK_RIGHT_STYLE },
                isStarted
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'span',
                        {
                          style: isChildRunning ? STATUS_PILL_RUNNING_STYLE : STATUS_PILL_DONE_STYLE,
                        },
                        isChildRunning ? '● ' : '✓ ',
                        isChildRunning ? formatCopy(t, 'statusRunning') : formatCopy(t, 'statusDone'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          'data-dsh-suggested-task-open': startedInfo.sessionId,
                          onClick: () => {
                            if (typeof openSession === 'function') {
                              openSession(startedInfo.sessionId)
                            }
                          },
                          style: OPEN_CHILD_BTN_STYLE,
                        },
                        formatCopy(t, 'openChild'),
                        ' →',
                      ),
                    )
                  : h(
                      'button',
                      {
                        type: 'button',
                        'data-dsh-suggested-task-start': task.id,
                        disabled: isStarting,
                        onClick: () => handleStartOne(task),
                        style: {
                          ...SECONDARY_BTN_STYLE,
                          opacity: isStarting ? 0.6 : 1,
                        },
                      },
                      isStarting ? formatCopy(t, 'starting') : formatCopy(t, 'start'),
                    ),
              ),
            )
          }),
        ),
        errorText !== ''
          ? h('div', { 'data-dsh-suggested-task-error': '', style: ERROR_BANNER_STYLE }, errorText)
          : null,
      )
    }

    // ---------------------------------------------------------------- 2. Header Lineage & Sub-sessions switcher
    function HeaderLineageAction(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const useSessions = props.useSessions
      const useProjection = props.useProjection
      const openSession = props.openSession
      const t = props.t

      const [menuOpen, setMenuOpen] = React.useState(false)
      const [, forceUpdate] = React.useState(0)
      React.useEffect(() => localStore.subscribe(() => forceUpdate((n) => n + 1)), [])

      const snapshot = typeof useSessions === 'function' ? useSessions((state) => state) : undefined
      const ownProjection = typeof useProjection === 'function'
        ? useProjection(PROJECTION, (value) => value)
        : undefined

      const { childBySessionId, childrenByParentId } = deriveLineageIndex(snapshot)
      const childInfo = ownProjection?.childOf ?? childBySessionId.get(sessionId) ?? null
      const children = childrenByParentId.get(sessionId) ?? []

      const elements = []

      // If this session is a child sub-session created from a suggested task:
      if (childInfo && typeof childInfo.parentSessionId === 'string' && childInfo.parentSessionId !== '') {
        const parentSummary = snapshot?.byId?.[childInfo.parentSessionId]
        const parentTitle = parentSummary?.displayTitle || parentSummary?.title || ''
        const label = parentTitle !== ''
          ? formatCopy(t, 'parentBadge', { title: parentTitle })
          : formatCopy(t, 'parentFallback')

        elements.push(
          h(
            'button',
            {
              key: 'parent-link',
              type: 'button',
              'data-dsh-task-parent-link': childInfo.parentSessionId,
              onClick: () => {
                if (typeof openSession === 'function') openSession(childInfo.parentSessionId)
              },
              style: {
                ...HEADER_PILL_STYLE,
                borderColor: 'rgba(59, 130, 246, 0.35)',
                background: 'rgba(59, 130, 246, 0.1)',
                color: 'var(--dsw-alias-brand-text, #3b82f6)',
              },
              title: childInfo.worktreePath || label,
            },
            '↖ ',
            label,
          ),
        )

        if (typeof childInfo.branch === 'string' && childInfo.branch !== '') {
          elements.push(
            h(
              'span',
              {
                key: 'worktree-chip',
                'data-dsh-task-worktree-chip': childInfo.branch,
                style: BRANCH_CHIP_STYLE,
                title: childInfo.worktreePath || childInfo.branch,
              },
              '⎇ ',
              childInfo.branch,
            ),
          )
        }
      }

      // If this session has spawned child task sub-sessions:
      if (children.length > 0) {
        const runningCount = children.filter((child) => Boolean(snapshot?.byId?.[child.sessionId]?.running)).length
        elements.push(
          h(
            'div',
            {
              key: 'children-dropdown',
              style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
            },
            h(
              'button',
              {
                type: 'button',
                'data-dsh-task-children-trigger': '',
                onClick: () => setMenuOpen((open) => !open),
                style: HEADER_PILL_STYLE,
              },
              h(SubsessionTreeIcon, { size: 13 }),
              formatCopy(t, 'childrenCount', { count: children.length }),
              runningCount > 0
                ? h(
                    'span',
                    {
                      style: {
                        marginLeft: '4px',
                        color: 'var(--dsw-alias-brand-text, #3b82f6)',
                        fontWeight: 600,
                      },
                    },
                    `· ${formatCopy(t, 'childrenRunning', { running: runningCount })}`,
                  )
                : null,
            ),
            menuOpen
              ? h(
                  'div',
                  {
                    'data-dsh-task-children-menu': '',
                    style: {
                      position: 'absolute',
                      top: 'calc(100% + 6px)',
                      left: 0,
                      zIndex: 60,
                      minWidth: '250px',
                      padding: '6px',
                      borderRadius: '10px',
                      border: '1px solid var(--dsw-alias-border-default, rgba(128, 128, 128, 0.25))',
                      background: 'var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-layer-1, #1e1e24))',
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.22)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                    },
                  },
                  ...children.map((child) => {
                    const childSummary = snapshot?.byId?.[child.sessionId]
                    const childTitle = childSummary?.displayTitle || child.title || child.sessionId
                    const running = Boolean(childSummary?.running)
                    return h(
                      'button',
                      {
                        key: child.sessionId,
                        type: 'button',
                        onClick: () => {
                          setMenuOpen(false)
                          if (typeof openSession === 'function') openSession(child.sessionId)
                        },
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          width: '100%',
                          padding: '6px 8px',
                          borderRadius: '7px',
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--dsw-alias-text-primary, inherit)',
                          fontSize: '12px',
                          textAlign: 'left',
                          cursor: 'pointer',
                        },
                      },
                      h(
                        'span',
                        { style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
                        h(SubsessionTreeIcon, { size: 12 }),
                        h(
                          'span',
                          { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 } },
                          childTitle,
                        ),
                      ),
                      h(
                        'span',
                        {
                          style: {
                            fontSize: '11px',
                            color: running ? 'var(--dsw-alias-brand-text, #3b82f6)' : '#10b981',
                            flexShrink: 0,
                          },
                        },
                        running ? formatCopy(t, 'statusRunning') : formatCopy(t, 'statusDone'),
                      ),
                    )
                  }),
                )
              : null,
          ),
        )
      }

      if (elements.length === 0) return null
      return h(
        'div',
        {
          'data-dsh-suggested-task-lineage': '',
          style: { display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
        },
        ...elements,
      )
    }

    // ---------------------------------------------------------------- 3. Sidebar Sub-session Leading & Hover + Tree Indentation
    function useSessionsListSnapshot(sessionsService) {
      const list = sessionsService?.list
      const [snapshot, setSnapshot] = React.useState(() => {
        try {
          return list?.getSnapshot?.()
        } catch {
          return undefined
        }
      })
      React.useEffect(() => {
        if (list === undefined || typeof list.subscribe !== 'function') return undefined
        const sync = () => {
          try {
            setSnapshot(list.getSnapshot())
          } catch {
            // Ignore snapshot errors.
          }
        }
        const unsubList = list.subscribe(sync)
        const unsubLocal = localStore.subscribe(sync)
        sync()
        return () => {
          if (typeof unsubList === 'function') unsubList()
          if (typeof unsubLocal === 'function') unsubLocal()
        }
      }, [list])
      return snapshot
    }

    /**
     * Leading icon in the left sidebar session row (`sidebar.session.row.leading`)
     * for idle child task sub-sessions.
     */
    function SidebarSessionLeadingMark(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const snapshot = useSessionsListSnapshot(props.sessions)
      const t = props.t
      if (sessionId === '') return null

      const { childBySessionId } = deriveLineageIndex(snapshot)
      const childInfo = childBySessionId.get(sessionId)
      if (childInfo === undefined) return null

      const parentSummary = snapshot?.byId?.[childInfo.parentSessionId]
      const parentTitle = parentSummary?.displayTitle || parentSummary?.title || childInfo.parentSessionId
      return h(
        'span',
        {
          'data-dsh-task-subsession-mark': '',
          title: formatCopy(t, 'hoverSubsessionOf', { parent: parentTitle }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '16px',
            height: '16px',
          },
        },
        h(SubsessionTreeIcon, { size: 14 }),
      )
    }

    /**
     * Hover card detail (`sidebar.session.row.hover`) for child and parent task sessions.
     */
    function SidebarSessionHoverCard(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const snapshot = useSessionsListSnapshot(props.sessions)
      const t = props.t
      if (sessionId === '') return null

      const { childBySessionId, childrenByParentId } = deriveLineageIndex(snapshot)
      const childInfo = childBySessionId.get(sessionId)
      const children = childrenByParentId.get(sessionId) ?? []

      if (childInfo === undefined && children.length === 0) return null

      const rows = []
      if (childInfo !== undefined) {
        const parentSummary = snapshot?.byId?.[childInfo.parentSessionId]
        const parentTitle = parentSummary?.displayTitle || parentSummary?.title || childInfo.parentSessionId
        rows.push(
          h(
            'div',
            {
              key: 'parent',
              style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', fontWeight: 500 },
            },
            h(SubsessionTreeIcon, { size: 12 }),
            h('span', null, formatCopy(t, 'hoverSubsessionOf', { parent: parentTitle })),
          ),
        )
        if (childInfo.branch) {
          rows.push(
            h(
              'div',
              {
                key: 'branch',
                style: { fontSize: '11px', color: 'var(--dsw-alias-text-tertiary, inherit)' },
              },
              formatCopy(t, 'hoverWorktree', { branch: childInfo.branch }),
            ),
          )
        }
      }

      if (children.length > 0) {
        rows.push(
          h(
            'div',
            {
              key: 'children-header',
              style: { fontSize: '11.5px', fontWeight: 600, marginTop: childInfo ? '4px' : '0' },
            },
            formatCopy(t, 'hoverChildrenTitle', { count: children.length }),
          ),
        )
        for (const child of children.slice(0, 3)) {
          const summary = snapshot?.byId?.[child.sessionId]
          const title = summary?.displayTitle || child.title || child.sessionId
          rows.push(
            h(
              'div',
              {
                key: child.sessionId,
                style: { display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px' },
              },
              h(SubsessionTreeIcon, { size: 11 }),
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, title),
            ),
          )
        }
      }

      return h(
        'div',
        {
          'data-dsh-task-subsession-hover': '',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            paddingTop: '4px',
          },
        },
        ...rows,
      )
    }

    /**
     * Maintain dynamic CSS rules that indent child task session rows in the left
     * Workspace sidebar (`--dsh-workspace-indent: 16px`) and draw a tree branch
     * connector line so child sessions visually group under their parent.
     */
    function installSidebarTreeStyles(ctx) {
      const list = ctx.sessions?.list
      if (list === undefined || typeof list.getSnapshot !== 'function') return

      const updateStyles = () => {
        if (typeof document === 'undefined' || !document.head) return
        let snapshot
        try {
          snapshot = list.getSnapshot()
        } catch {
          return
        }
        const { childBySessionId } = deriveLineageIndex(snapshot)
        let styleEl = document.head.querySelector('style[data-dsh-suggested-task-tree]')
        if (childBySessionId.size === 0) {
          if (styleEl) styleEl.textContent = ''
          return
        }
        if (!styleEl) {
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-dsh-suggested-task-tree', '')
          document.head.appendChild(styleEl)
        }
        const selectors = []
        for (const childId of childBySessionId.keys()) {
          const escaped = String(childId).replace(/["\\]/gu, '\\$&')
          selectors.push(`[data-row-key="session:${escaped}"]`)
        }
        const joined = selectors.join(',\n')
        const beforeJoined = selectors.map((sel) => `${sel}::before`).join(',\n')
        styleEl.textContent = [
          `${joined} {`,
          '  --dsh-workspace-indent: 16px !important;',
          '  position: relative;',
          '}',
          `${beforeJoined} {`,
          '  content: "";',
          '  position: absolute;',
          '  inset-inline-start: 14px;',
          '  top: 0;',
          '  bottom: 0;',
          '  width: 1.5px;',
          '  background: var(--dsw-alias-border-default, rgba(128, 128, 128, 0.28));',
          '  pointer-events: none;',
          '}',
        ].join('\n')
      }

      ctx.effect(() => {
        const unsubList = typeof list.subscribe === 'function' ? list.subscribe(updateStyles) : undefined
        const unsubLocal = localStore.subscribe(updateStyles)
        updateStyles()
        return () => {
          if (typeof unsubList === 'function') unsubList()
          if (typeof unsubLocal === 'function') unsubLocal()
        }
      }, 'suggested-task: sidebar tree styles')
    }

    // ---------------------------------------------------------------- 4. `/tasks` Command View
    const handledCommandIds = new Set()

    function SuggestedTaskCommandView(props) {
      const node = props.node
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const t = props.t
      const outcome = node !== null && typeof node === 'object' ? node.outcome ?? null : null

      React.useEffect(() => {
        if (outcome?.kind !== 'success') return
        const commandId = typeof node?.commandId === 'string' ? node.commandId : undefined
        if (commandId !== undefined && handledCommandIds.has(commandId)) return
        if (commandId !== undefined) handledCommandIds.add(commandId)
        const payload = parseCommandPayload(outcome.text)
        if (payload?.action === 'started' && typeof payload.turn === 'number' && Array.isArray(payload.started)) {
          localStore.recordStarted(sessionId, payload.turn, payload.started)
        } else if (payload?.action === 'generated' && typeof payload.turn === 'number' && Array.isArray(payload.tasks)) {
          localStore.recordGenerated(sessionId, payload.turn, payload)
        }
      }, [node, outcome, sessionId])

      if (outcome === null) {
        return h(
          'div',
          {
            'data-dsh-suggested-task-command': 'pending',
            style: {
              padding: '6px 10px',
              fontSize: '12px',
              color: 'var(--dsw-alias-text-secondary, inherit)',
            },
          },
          formatCopy(t, 'commandPending'),
        )
      }

      if (outcome.kind === 'error') {
        return h(
          'div',
          {
            'data-dsh-suggested-task-command': 'error',
            style: ERROR_BANNER_STYLE,
          },
          outcome.text || formatCopy(t, 'commandFailed'),
        )
      }

      return null
    }

    // ---------------------------------------------------------------- Plugin Registration
    return {
      inject: ['slots', 'locale'],
      /**
       * Register dictionaries, the turn-tail card, header lineage pills,
       * sidebar sub-session indicators, and `/tasks` command view.
       * @param {any} ctx
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))

        const openSession = (targetSessionId) => {
          ctx.uiWorkspace?.openSession?.(targetSessionId)
        }

        ctx.effect(() =>
          ctx.slots.inject('conversation.chat.turnTail', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.turnTail',
                id: 'suggested-tasks',
                order: 15,
                locale: NS,
                inject: (sessionId) => ({
                  sessionId,
                  loadProjection: (id) => ctx.remote?.session?.projections?.({ sessionId: id }),
                  executeCommand: (id, line) => ctx.remote?.commands?.execute?.(id, line, []),
                  openSession,
                }),
              },
              SuggestedTasksTurnCard,
            ),
          ),
        )

        ctx.effect(() =>
          ctx.slots.inject('conversation.session.header.actions', () =>
            ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'suggested-task-lineage',
                order: -10,
                locale: NS,
                inject: (sessionId) => ({
                  sessionId,
                  openSession,
                }),
              },
              HeaderLineageAction,
            ),
          ),
        )

        ctx.effect(() =>
          ctx.slots.inject('sidebar.session.row.leading', () =>
            ctx.slots.register(
              {
                name: 'sidebar.session.row.leading',
                id: 'suggested-task-subsession',
                order: 5,
                locale: NS,
                inject: () => ({
                  sessions: ctx.sessions,
                }),
              },
              SidebarSessionLeadingMark,
            ),
          ),
        )

        ctx.effect(() =>
          ctx.slots.inject('sidebar.session.row.hover', () =>
            ctx.slots.register(
              {
                name: 'sidebar.session.row.hover',
                id: 'suggested-task-hover',
                order: 5,
                locale: NS,
                inject: () => ({
                  sessions: ctx.sessions,
                }),
              },
              SidebarSessionHoverCard,
            ),
          ),
        )

        ctx.effect(() =>
          ctx.slots.inject('conversation.chat.commandview', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.commandview',
                key: COMMAND,
                locale: NS,
              },
              SuggestedTaskCommandView,
            ),
          ),
        )

        installSidebarTreeStyles(ctx)
      },
    }
  },
})
