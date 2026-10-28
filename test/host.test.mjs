import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  COMMAND_NAME,
  PROJECTION_KEY,
  apply,
  buildDigestInput,
  buildForkContext,
  createGitWorktree,
  encodeCommandPayload,
  extractWorktreeBranch,
  latestTurn,
  parseCommandPayload,
  parseSuggestedTasks,
  recentDialogue,
  resolveConfig,
  sanitizeBranchSlug,
  toolsForTurn,
  turnEndSeq,
} from '../index.js'

function userEvent(text, seq = 1) {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }] } }
}

function assistantEvent(text, seq = 2) {
  return { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
}

function fakeSession(events, id = 'session-parent', header = { id: 'session-parent', cwd: '/repo' }) {
  return {
    id,
    header,
    ownEvents: () => events,
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
  }
}

function rootContext(scoped, listeners) {
  return {
    inject: (_names, callback) => callback(scoped),
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    get(name) {
      return scoped.get?.(name) ?? scoped[name]
    },
    logger: scoped.logger ?? { warn() {} },
  }
}

test('resolveConfig supplies defaults and sanitizes invalid values', () => {
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.mode, 'fork')
  assert.equal(defaults.maxTasks, 3)
  assert.equal(defaults.maxTokens, 1024)
  assert.equal(defaults.temperature, 0.3)
  assert.equal(defaults.timeoutMs, 15000)
  assert.equal(defaults.fallback, true)
  assert.equal(defaults.skipSubagents, true)
  assert.equal(defaults.skipTaskSessions, true)
  assert.equal(defaults.worktreePrefix, 'task/')
  assert.equal(defaults.worktreeFallback, true)

  const invalid = resolveConfig({
    enabled: 'no',
    mode: 'bad',
    maxTasks: 99,
    maxTokens: -5,
    temperature: 9,
    timeoutMs: 10,
  })
  assert.equal(invalid.enabled, true)
  assert.equal(invalid.mode, 'fork')
  assert.equal(invalid.maxTasks, 3)
  assert.equal(invalid.maxTokens, 1024)
  assert.equal(invalid.temperature, 0.3)
  assert.equal(invalid.timeoutMs, 15000)

  const custom = resolveConfig({
    enabled: false,
    mode: 'digest',
    maxTasks: 4,
    worktreePrefix: 'feat/',
    worktreeFallback: false,
    provider: 'p',
    model: 'm',
  })
  assert.equal(custom.enabled, false)
  assert.equal(custom.mode, 'digest')
  assert.equal(custom.maxTasks, 4)
  assert.equal(custom.worktreePrefix, 'feat/')
  assert.equal(custom.worktreeFallback, false)
  assert.equal(custom.provider, 'p')
  assert.equal(custom.model, 'm')
})

test('sanitizeBranchSlug and extractWorktreeBranch normalize branch names and paths', () => {
  assert.equal(sanitizeBranchSlug('Add Unit Tests!', 'task/', 1), 'task/add-unit-tests')
  assert.equal(sanitizeBranchSlug('task/fix-login-bug', 'task/', 1), 'task/fix-login-bug')
  assert.equal(sanitizeBranchSlug('中文标题', 'task/', 2), 'task/followup-2')
  assert.equal(
    extractWorktreeBranch('D:\\repo\\.agents\\worktrees\\task\\add-unit-tests'),
    'task/add-unit-tests',
  )
  assert.equal(extractWorktreeBranch('/Users/dev/project/src'), '')
})

test('parseSuggestedTasks parses JSON arrays, fenced JSON, and deduplicates branches', () => {
  const raw = [
    '```json',
    JSON.stringify([
      {
        title: '补充单元测试',
        description: '为新增的任务解析器编写边界条件测试',
        prompt: '在 test/host.test.mjs 中为 parseSuggestedTasks 添加完整单元测试并运行 npm test。',
        branch: 'add-unit-tests',
      },
      {
        title: '更新 README 文档',
        description: '补充配置项说明与安装指南',
        prompt: '更新 README.md 与 README.zh.md 中的配置表。',
        branch: 'add-unit-tests',
      },
    ]),
    '```',
  ].join('\n')

  const tasks = parseSuggestedTasks(raw, 3, 'task/')
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].id, 't1')
  assert.equal(tasks[0].title, '补充单元测试')
  assert.equal(tasks[0].branch, 'task/add-unit-tests')
  assert.equal(tasks[1].id, 't2')
  assert.equal(tasks[1].branch, 'task/add-unit-tests-2')

  assert.deepEqual(parseSuggestedTasks('NONE'), [])
  assert.deepEqual(parseSuggestedTasks('[]'), [])
})

test('encodeCommandPayload and parseCommandPayload round-trip structured payloads', () => {
  const encoded = encodeCommandPayload({ action: 'started', turn: 2, started: [{ taskId: 't1', sessionId: 's-child' }] })
  const decoded = parseCommandPayload(encoded)
  assert.deepEqual(decoded, { action: 'started', turn: 2, started: [{ taskId: 't1', sessionId: 's-child' }] })
  assert.equal(parseCommandPayload('plain command output'), undefined)
})

test('recentDialogue, toolsForTurn, latestTurn, turnEndSeq, and buildDigestInput inspect the session log', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    userEvent('Implement feature X', 2),
    { type: 'tool/call', seq: 3, data: { name: 'edit' } },
    { type: 'tool/call', seq: 4, data: { name: 'bash' } },
    assistantEvent('Feature X is implemented.', 5),
    { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = fakeSession(events)
  assert.equal(latestTurn(session), 1)
  assert.equal(turnEndSeq(session, 1), 6)
  assert.deepEqual(toolsForTurn(session, 1), ['edit', 'bash'])
  assert.deepEqual(recentDialogue(session), {
    users: ['Implement feature X'],
    replies: ['Feature X is implemented.'],
  })

  const digest = JSON.parse(buildDigestInput(session, 1, resolveConfig({})))
  assert.deepEqual(digest.recent_user_messages, ['Implement feature X'])
  assert.equal(digest.latest_assistant_reply, 'Feature X is implemented.')
  assert.deepEqual(digest.tools_used, ['edit', 'bash'])
})

test('buildForkContext preserves assistant source metadata and appends the synthetic trigger', () => {
  const source = {
    kind: 'model',
    provider: 'test-provider',
    model: 'test-model',
    replayState: { blocks: [{ type: 'text' }] },
  }
  const conversation = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    { role: 'user', content: [{ type: 'text', text: 'Build suggested tasks' }] },
    {
      role: 'assistant',
      id: 'assistant-1',
      source,
      content: [
        { type: 'text', text: 'Done.' },
        { type: 'tool-call', id: 'c1', name: 'write', arguments: '{}' },
      ],
    },
  ]
  const context = buildForkContext({ deriveMessages: () => conversation }, resolveConfig({}))
  assert.ok(context !== undefined)
  assert.ok(context.system.startsWith('SYSTEM'))
  assert.equal(context.messages.length, 3)
  assert.deepEqual(context.messages[1].source, source)
  assert.equal(context.messages[2].content[0].text, 'Suggest follow-up tasks.')
})

test('new session projection state and summary survive a lossless JSON round-trip', () => {
  let definition
  const scoped = {
    sessionProjections: { register(value) { definition = value } },
    commands: { register() {} },
  }
  apply(rootContext(scoped, {}), {})

  const state = definition.init({ id: 'new-session' }, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)

  const summary = {
    sessionId: 'new-session',
    projections: { values: { [PROJECTION_KEY]: definition.wire.view(state) } },
  }
  // api-session/added forwards this projection and rejects lossy JSON values.
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary)
})

test('cached projection states with missing or undefined failures remain lossless JSON on the wire', () => {
  let definition
  const scoped = {
    sessionProjections: { register(value) { definition = value } },
    commands: { register() {} },
  }
  apply(rootContext(scoped, {}), {})

  const cached = {
    sessionId: 'cached-session', parentSessionId: '',
    inheritedEventCount: 0, childOf: null, turns: {},
  }
  for (const state of [cached, { ...cached, lastFailure: undefined }]) {
    const view = definition.wire.view(state)
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
    assert.equal(view.lastFailure, undefined)
  }
})

test('failed suggestion generation preserves its failure record as lossless JSON', async () => {
  let definition
  const listeners = {}
  const scoped = {
    sessionProjections: { register(value) { definition = value } },
    commands: { register() {} },
    on(name, listener) { listeners[name] = listener },
    llm: {
      async prepareCall(config) {
        return {
          config,
          stream: async function* () {
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
  apply(rootContext(scoped, listeners), { mode: 'digest', fallback: false })
  const session = fakeSession([userEvent('Add a parser'), assistantEvent('Parser added.')])
  let state = definition.init(session.header, 0)
  await listeners['agent/turn-stopping']({ agent: { session }, turn: 1 })
  state = definition.apply(state, {
    type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } },
  })

  assert.equal(state.lastFailure.turn, 1)
  assert.equal(typeof state.lastFailure.reason, 'string')
  assert.equal(typeof state.lastFailure.at, 'number')
  const view = definition.wire.view(state)
  assert.deepEqual(view.lastFailure, state.lastFailure)
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('turn-stopping generates suggestions and turn/end publishes them into the projection', async () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    userEvent('Add parser module', 2),
    assistantEvent('Parser module added.', 3),
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = fakeSession(events)
  const listeners = {}
  let definition
  const scoped = {
    sessionProjections: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    commands: {
      register() {
        return () => {}
      },
    },
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    llm: {
      async prepareCall(config, _signal, configure) {
        const controls = configure
          ? configure({ ...config }, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
          : config
        assert.equal(controls.reasoningEffort, 'low')
        return {
          config: controls,
          stream: async function* () {
            yield {
              type: 'text-delta',
              index: 0,
              text: JSON.stringify([
                {
                  title: 'Run unit tests',
                  description: 'Verify parser edge cases',
                  prompt: 'Run the unit test suite for the parser module.',
                  branch: 'parser-tests',
                },
              ]),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    logger: { warn() {} },
  }

  apply(rootContext(scoped, listeners), { mode: 'digest' })
  assert.equal(definition.key, PROJECTION_KEY)

  let state = definition.init(session.header, 0)
  await listeners['agent/turn-stopping']({ agent: { session }, turn: 1 })
  state = definition.apply(state, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } })

  const view = definition.wire.view(state)
  assert.equal(view.turns['1'].tasks.length, 1)
  assert.equal(view.turns['1'].tasks[0].title, 'Run unit tests')
  assert.equal(view.turns['1'].tasks[0].branch, 'task/parser-tests')
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view)
})

test('createGitWorktree creates a git worktree under .agents/worktrees and switches workingDirectory', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-suggested-task-test-'))
  try {
    const gitCalls = []
    const fakeExecGit = async (cwd, args) => {
      gitCalls.push({ cwd, args })
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { exitCode: 0, stdout: `${tempRoot}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') {
        return { exitCode: 0, stdout: 'abc1234567890\n', stderr: '' }
      }
      if (args[0] === 'show-ref') {
        return { exitCode: 1, stdout: '', stderr: '' }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }

    let switchedPath = ''
    const childAgent = { id: 'session-child', session: { id: 'session-child', header: { cwd: tempRoot } } }
    const fakeCtx = {
      get(name) {
        if (name === 'workingDirectory') {
          return {
            async set(_agent, targetPath) {
              switchedPath = targetPath
              return targetPath
            },
          }
        }
        return undefined
      },
    }

    const result = await createGitWorktree(fakeCtx, childAgent, tempRoot, 'task/parser-tests', undefined, fakeExecGit)
    assert.equal(result.branch, 'task/parser-tests')
    assert.equal(result.baseCommit, 'abc1234567890')
    assert.ok(result.path.endsWith(path.join('.agents', 'worktrees', 'task', 'parser-tests')))
    assert.equal(switchedPath, result.path)
    assert.ok(gitCalls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'))
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('/tasks start and start-all fork child sessions, create worktrees, position in workspace, and fold lineage', async () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    userEvent('Implement auth service', 2),
    assistantEvent('Auth service implemented.', 3),
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const parentSession = fakeSession(events, 'session-parent', { id: 'session-parent', cwd: '/repo' })
  const listeners = {}
  let definition
  let registeredCommand

  const forkedSessions = []
  const renamedSessions = []
  const promptedSessions = []
  const worktreeCalls = []
  const childAgents = new Map()
  const workspaceSessionIds = ['session-older', 'session-parent', 'session-trailing']

  const workspace = {
    sessionIds: workspaceSessionIds,
    async insertSessionBefore(sessionId, beforeSessionId) {
      const without = this.sessionIds.filter((id) => id !== sessionId)
      const index = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      without.splice(index < 0 ? without.length : index, 0, sessionId)
      this.sessionIds = without
    },
  }

  const scoped = {
    sessionProjections: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    commands: {
      register(cmd) {
        registeredCommand = cmd
        return () => {}
      },
    },
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    llm: {
      async prepareCall(config) {
        return {
          config,
          stream: async function* () {
            yield {
              type: 'text-delta',
              index: 0,
              text: JSON.stringify([
                {
                  title: 'Add auth unit tests',
                  description: 'Test token validation and expiry',
                  prompt: 'Write unit tests for token validation and expiry.',
                  branch: 'auth-tests',
                },
                {
                  title: 'Add auth docs',
                  description: 'Document auth configuration',
                  prompt: 'Document the auth configuration options in README.md.',
                  branch: 'auth-docs',
                },
              ]),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    get(name) {
      if (name === 'llm') return this.llm
      if (name === 'agents') return { get: (id) => childAgents.get(id) }
      if (name === 'workspaceRegistry') return { list: () => [workspace] }
      if (name === 'worktrees') {
        return {
          async create(agent, req) {
            const wtPath = `/repo/.agents/worktrees/${req.name}`
            worktreeCalls.push({ agentId: agent.id, name: req.name, path: wtPath })
            return {
              path: wtPath,
              branch: req.name,
              baseCommit: 'deadbeef',
              repositoryRoot: '/repo',
            }
          },
        }
      }
      if (name === 'sessionController') {
        return {
          async fork(req) {
            const childId = `session-child-${forkedSessions.length + 1}`
            forkedSessions.push({ ...req, childId })
            workspace.sessionIds.unshift(childId)
            const childAgent = {
              id: childId,
              session: {
                id: childId,
                header: { id: childId, cwd: '/repo', parentSession: req.sessionId },
              },
            }
            childAgents.set(childId, childAgent)
            return { sessionId: childId }
          },
          async rename(req) {
            renamedSessions.push(req)
            return { title: req.title, seq: 5 }
          },
          async prompt(req) {
            promptedSessions.push(req)
            return { accepted: true }
          },
        }
      }
      return undefined
    },
    logger: { warn() {} },
  }

  apply(rootContext(scoped, listeners), { mode: 'digest' })
  assert.equal(registeredCommand.name, COMMAND_NAME)

  let parentState = definition.init(parentSession.header, 0)
  await listeners['agent/turn-stopping']({ agent: { session: parentSession }, turn: 1 })
  parentState = definition.apply(parentState, {
    type: 'turn/end',
    seq: 4,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.equal(parentState.turns['1'].tasks.length, 2)

  // 1. Start the first task individually via `/tasks start 1 t1`.
  const startOneRes = await registeredCommand.handler({
    commandId: 'cmd-1',
    agent: { session: parentSession },
    rawInput: 'start 1 t1',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(startOneRes.kind, 'success')
  assert.equal(forkedSessions.length, 1)
  assert.equal(forkedSessions[0].sessionId, 'session-parent')
  assert.equal(forkedSessions[0].atSeq, 4)
  assert.equal(worktreeCalls.length, 1)
  assert.equal(worktreeCalls[0].name, 'task/auth-tests')
  assert.equal(renamedSessions[0].title, 'Add auth unit tests')
  assert.ok(promptedSessions[0].content[0].text.includes('Write unit tests for token validation'))
  assert.ok(promptedSessions[0].content[0].text.includes('task/auth-tests'))

  // Fold the `command/done` event into the parent projection.
  parentState = definition.apply(parentState, {
    type: 'command/done',
    seq: 5,
    data: { commandId: 'cmd-1', kind: 'success', text: startOneRes.text },
  })
  assert.equal(parentState.turns['1'].started.t1.sessionId, 'session-child-1')
  assert.equal(parentState.turns['1'].started.t1.branch, 'task/auth-tests')

  // Verify the child session projection knows its `childOf` lineage and ignores inherited parent turns!
  const child1Session = childAgents.get('session-child-1').session
  let child1State = definition.init(child1Session.header, 5)
  assert.equal(child1State.childOf?.parentSessionId, 'session-parent')
  assert.equal(child1State.childOf?.branch, 'task/auth-tests')
  // Replaying the inherited turn/end (seq 4 < inheritedEventCount 5) must not populate child turns.
  child1State = definition.apply(child1State, {
    type: 'turn/end',
    seq: 4,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.deepEqual(child1State.turns, {})

  // 2. Start all remaining tasks via `/tasks start-all 1` (only t2 is unstarted).
  const startAllRes = await registeredCommand.handler({
    commandId: 'cmd-2',
    agent: { session: parentSession },
    rawInput: 'start-all 1',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(startAllRes.kind, 'success')
  assert.equal(forkedSessions.length, 2)
  assert.equal(worktreeCalls.length, 2)
  assert.equal(worktreeCalls[1].name, 'task/auth-docs')

  parentState = definition.apply(parentState, {
    type: 'command/done',
    seq: 6,
    data: { commandId: 'cmd-2', kind: 'success', text: startAllRes.text },
  })
  assert.equal(parentState.turns['1'].started.t2.sessionId, 'session-child-2')

  // Both child sessions are positioned right underneath `session-parent` in order!
  assert.deepEqual(workspace.sessionIds, [
    'session-older',
    'session-parent',
    'session-child-1',
    'session-child-2',
    'session-trailing',
  ])
})

test('cold replay reconstructs childOf from header.parentSession, working-directory/change, and session/title', () => {
  let definition
  const scoped = {
    sessionProjections: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    commands: { register: () => () => {} },
    llm: { async prepareCall() {} },
    logger: { warn() {} },
  }
  apply(rootContext(scoped, {}), {})

  let state = definition.init({ id: 'cold-child', parentSession: 'cold-parent', cwd: '/repo' }, 8)
  assert.equal(state.childOf, null)

  // Replay an inherited event (seq 3 < 8): ignored
  state = definition.apply(state, {
    type: 'working-directory/change',
    seq: 3,
    data: { cwd: '/repo/.agents/worktrees/task/old' },
  })
  assert.equal(state.childOf, null)

  // Replay the child's own working-directory/change (seq 8 >= 8): reconstructs childOf!
  state = definition.apply(state, {
    type: 'working-directory/change',
    seq: 8,
    data: { cwd: '/repo/.agents/worktrees/task/reconstructed-branch' },
  })
  assert.equal(state.childOf?.parentSessionId, 'cold-parent')
  assert.equal(state.childOf?.branch, 'task/reconstructed-branch')
  assert.equal(state.childOf?.worktreePath, '/repo/.agents/worktrees/task/reconstructed-branch')

  // Replay session/title (seq 9 >= 8): populates title
  state = definition.apply(state, {
    type: 'session/title',
    seq: 9,
    data: { title: 'Reconstructed Task Title' },
  })
  assert.equal(state.childOf?.title, 'Reconstructed Task Title')
})

test('fork mode falls back to digest mode when fork returns empty output, and /tasks generate folds via command/done', async () => {
  const conversation = [
    { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
    { role: 'user', content: [{ type: 'text', text: 'Add login endpoint' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Endpoint added.' }] },
  ]
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    userEvent('Add login endpoint', 2),
    assistantEvent('Endpoint added.', 3),
    { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const session = {
    ...fakeSession(events),
    deriveMessages: () => conversation,
  }
  const listeners = {}
  let definition
  let registeredCommand
  let callCount = 0

  const scoped = {
    sessionProjections: {
      register(value) {
        definition = value
        return () => {}
      },
    },
    commands: {
      register(cmd) {
        registeredCommand = cmd
        return () => {}
      },
    },
    on(name, listener) {
      listeners[name] = listener
      return () => {}
    },
    llm: {
      async prepareCall(config) {
        return {
          config,
          stream: async function* () {
            callCount += 1
            if (callCount === 1) {
              // Fork attempt returns empty
              yield { type: 'finish', reason: { kind: 'stop' } }
              return
            }
            yield {
              type: 'text-delta',
              index: 0,
              text: JSON.stringify([
                {
                  title: 'Test login endpoint',
                  description: 'Add integration tests for /login',
                  prompt: 'Write integration tests for POST /login.',
                  branch: 'login-tests',
                },
              ]),
            }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
    logger: { warn() {} },
  }

  apply(rootContext(scoped, listeners), { mode: 'fork', fallback: true })
  let state = definition.init(session.header, 0)
  await listeners['agent/turn-stopping']({ agent: { session }, turn: 1 })
  assert.equal(callCount, 2)

  state = definition.apply(state, {
    type: 'turn/end',
    seq: 4,
    data: { turn: 1, reason: { kind: 'completed' } },
  })
  assert.equal(state.turns['1'].mode, 'digest')
  assert.equal(state.turns['1'].tasks[0].title, 'Test login endpoint')

  // On-demand `/tasks generate 1`
  const genRes = await registeredCommand.handler({
    commandId: 'cmd-gen',
    agent: { session },
    rawInput: 'generate 1',
    attachments: [],
    signal: new AbortController().signal,
  })
  assert.equal(genRes.kind, 'success')
  state = definition.apply(state, {
    type: 'command/done',
    seq: 5,
    data: { commandId: 'cmd-gen', kind: 'success', text: genRes.text },
  })
  assert.equal(state.turns['1'].tasks[0].title, 'Test login endpoint')
})

test('package.json and cordis.patch.yml declare the expected bundle contract', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.name, '@local/dsh-suggested-task')
  assert.equal(manifest.engines?.dsh, '^0.2.1-rc.2')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh?.client?.platform, 'web')

  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(patch.includes("name: '@local/dsh-suggested-task'"))
})
