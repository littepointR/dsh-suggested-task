import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { encodeCommandPayload } from '../index.js'

/**
 * Structural tests for the Client half (`client.js`).
 *
 * Exercises slot registrations, locale parity, the turn-tail Suggested Tasks
 * card, single & batch task starting, sub-session opening, conversation header
 * parent/child lineage pills, and left-sidebar sub-session markers.
 */

const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useRef(initial) {
    return { current: initial }
  },
  useEffect() {},
}

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}

let captured
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

await import('../client.js')

function makeHarness() {
  const state = {
    dictionaries: undefined,
    slots: [],
    openedSessions: [],
    executedCommands: [],
    listSnapshot: {
      byId: {
        'session-parent': {
          id: 'session-parent',
          displayTitle: 'Refactor Auth Module',
          running: false,
          projectionValues: {
            suggestedTasks: {
              parentSessionId: '',
              inheritedEventCount: 0,
              childOf: null,
              turns: {
                1: {
                  turn: 1,
                  tasks: [
                    {
                      id: 't1',
                      title: 'Add unit tests',
                      description: 'Cover token validation edge cases',
                      prompt: 'Write unit tests for token validation.',
                      branch: 'task/auth-tests',
                    },
                    {
                      id: 't2',
                      title: 'Update API docs',
                      description: 'Document new auth headers',
                      prompt: 'Update docs/auth.md with the new headers.',
                      branch: 'task/auth-docs',
                    },
                  ],
                  started: {},
                },
              },
            },
          },
        },
        'session-child-1': {
          id: 'session-child-1',
          displayTitle: 'Add unit tests',
          running: true,
          parentId: 'session-parent',
          projectionValues: {
            suggestedTasks: {
              parentSessionId: 'session-parent',
              inheritedEventCount: 5,
              childOf: {
                parentSessionId: 'session-parent',
                parentTurn: 1,
                taskId: 't1',
                title: 'Add unit tests',
                branch: 'task/auth-tests',
                worktreePath: '/repo/.agents/worktrees/task/auth-tests',
              },
              turns: {},
            },
          },
        },
      },
    },
  }

  const ctx = {
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(_namespace, dictionaries) {
        state.dictionaries = dictionaries
        return () => {}
      },
    },
    slots: {
      inject(_name, callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(options, component) {
        state.slots.push({ options, component })
        return () => {}
      },
    },
    uiWorkspace: {
      openSession(sessionId) {
        state.openedSessions.push(sessionId)
      },
    },
    remote: {
      session: {
        async projections() {
          return { values: {} }
        },
      },
      commands: {
        async execute(sessionId, line, attachments) {
          state.executedCommands.push({ sessionId, line, attachments })
          return {
            ok: true,
            value: {
              result: {
                kind: 'success',
                text: encodeCommandPayload({
                  action: 'started',
                  turn: 1,
                  started: [
                    {
                      taskId: 't1',
                      sessionId: 'session-child-1',
                      title: 'Add unit tests',
                      branch: 'task/auth-tests',
                      worktreePath: '/repo/.agents/worktrees/task/auth-tests',
                      startedAt: 1000,
                    },
                  ],
                }),
              },
            },
          }
        },
      },
    },
    sessions: {
      list: {
        getSnapshot() {
          return state.listSnapshot
        },
        subscribe() {
          return () => {}
        },
      },
    },
  }

  const module = captured.factory(requireStub)
  module.apply(ctx)
  return { ctx, state }
}

/** Find a node in a rendered React element tree matching `predicate`. */
function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    const found = findNode(child, predicate)
    if (found !== undefined) return found
  }
  return undefined
}

test('the Client module registers all expected slots and matching zh/en dictionaries', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(source.includes("id: '@local/dsh-suggested-task'"))
  assert.equal(captured.id, '@local/dsh-suggested-task')

  const { state } = makeHarness()
  assert.ok(state.dictionaries !== undefined)
  assert.deepEqual(
    Object.keys(state.dictionaries.zh).sort(),
    Object.keys(state.dictionaries.en).sort(),
  )

  const slotNames = state.slots.map((entry) => entry.options.name)
  assert.ok(slotNames.includes('conversation.chat.turnTail'))
  assert.ok(slotNames.includes('conversation.session.header.actions'))
  assert.ok(slotNames.includes('sidebar.session.row.leading'))
  assert.ok(slotNames.includes('sidebar.session.row.hover'))
  assert.ok(slotNames.includes('conversation.chat.commandview'))
})

test('SuggestedTasksTurnCard renders tasks, starts single or all tasks, and opens child sub-sessions', async () => {
  const { state } = makeHarness()
  const turnTail = state.slots.find((entry) => entry.options.name === 'conversation.chat.turnTail')
  assert.ok(turnTail !== undefined)

  const injected = turnTail.options.inject('session-parent')
  const projection = state.listSnapshot.byId['session-parent'].projectionValues.suggestedTasks

  const element = turnTail.component({
    ...injected,
    turn: { turn: 1 },
    useProjection: (_key, select) => (select ? select(projection) : projection),
    useSessions: (select) => select(state.listSnapshot),
    t: (key) => state.dictionaries.en[key] ?? key,
  })

  assert.ok(element !== null)
  assert.equal(element.type, 'section')
  const serialized = JSON.stringify(element)
  assert.ok(serialized.includes('Add unit tests'))
  assert.ok(serialized.includes('task/auth-tests'))
  assert.ok(serialized.includes('Update API docs'))

  // Click "Start" on task t1.
  const startT1Button = findNode(
    element,
    (node) => node.type === 'button' && node.props?.['data-dsh-suggested-task-start'] === 't1',
  )
  assert.ok(startT1Button !== undefined)
  await startT1Button.props.onClick()
  assert.equal(state.executedCommands.at(-1)?.line, '/tasks start 1 t1')

  // Re-render after starting t1: t1 now shows running status and "Open sub-session" button.
  const elementAfterStart = turnTail.component({
    ...injected,
    turn: { turn: 1 },
    useProjection: (_key, select) => (select ? select(projection) : projection),
    useSessions: (select) => select(state.listSnapshot),
    t: (key) => state.dictionaries.en[key] ?? key,
  })
  const openChildButton = findNode(
    elementAfterStart,
    (node) => node.type === 'button' && node.props?.['data-dsh-suggested-task-open'] === 'session-child-1',
  )
  assert.ok(openChildButton !== undefined)
  openChildButton.props.onClick()
  assert.deepEqual(state.openedSessions, ['session-child-1'])

  // Click "Start all" for remaining unstarted tasks.
  const startAllButton = findNode(
    elementAfterStart,
    (node) => node.type === 'button' && node.props?.['data-dsh-suggested-task-start-all'] !== undefined,
  )
  assert.ok(startAllButton !== undefined)
  await startAllButton.props.onClick()
  assert.equal(state.executedCommands.at(-1)?.line, '/tasks start-all 1')
})

test('HeaderLineageAction renders parent breadcrumb + worktree chip on child session and sub-session count on parent', () => {
  const { state } = makeHarness()
  const headerSlot = state.slots.find((entry) => entry.options.name === 'conversation.session.header.actions')
  assert.ok(headerSlot !== undefined)

  // 1. Render header on child session `session-child-1`:
  const childInjected = headerSlot.options.inject('session-child-1')
  const childProj = state.listSnapshot.byId['session-child-1'].projectionValues.suggestedTasks
  const childHeader = headerSlot.component({
    ...childInjected,
    useSessions: (select) => select(state.listSnapshot),
    useProjection: (_key, select) => (select ? select(childProj) : childProj),
    t: (key) => state.dictionaries.en[key] ?? key,
  })
  assert.ok(childHeader !== null)
  const parentLink = findNode(
    childHeader,
    (node) => node.type === 'button' && node.props?.['data-dsh-task-parent-link'] === 'session-parent',
  )
  assert.ok(parentLink !== undefined)
  parentLink.props.onClick()
  assert.equal(state.openedSessions.at(-1), 'session-parent')

  const worktreeChip = findNode(
    childHeader,
    (node) => node.props?.['data-dsh-task-worktree-chip'] === 'task/auth-tests',
  )
  assert.ok(worktreeChip !== undefined)

  // 2. Render header on parent session `session-parent`:
  const parentInjected = headerSlot.options.inject('session-parent')
  const parentProj = state.listSnapshot.byId['session-parent'].projectionValues.suggestedTasks
  const parentHeader = headerSlot.component({
    ...parentInjected,
    useSessions: (select) => select(state.listSnapshot),
    useProjection: (_key, select) => (select ? select(parentProj) : parentProj),
    t: (key) => state.dictionaries.en[key] ?? key,
  })
  assert.ok(parentHeader !== null)
  const childrenTrigger = findNode(
    parentHeader,
    (node) => node.type === 'button' && node.props?.['data-dsh-task-children-trigger'] !== undefined,
  )
  assert.ok(childrenTrigger !== undefined)
})

test('SidebarSessionLeadingMark and SidebarSessionHoverCard mark child sub-sessions in the left sidebar', () => {
  const { state } = makeHarness()
  const leadingSlot = state.slots.find((entry) => entry.options.name === 'sidebar.session.row.leading')
  const hoverSlot = state.slots.find((entry) => entry.options.name === 'sidebar.session.row.hover')
  assert.ok(leadingSlot !== undefined)
  assert.ok(hoverSlot !== undefined)

  // Child session has leading sub-session mark:
  const childMark = leadingSlot.component({
    ...leadingSlot.options.inject(),
    sessionId: 'session-child-1',
    t: (key) => state.dictionaries.en[key] ?? key,
  })
  assert.ok(childMark !== null)
  assert.equal(childMark.props['data-dsh-task-subsession-mark'], '')

  // Ordinary parent session has no child leading mark:
  const parentMark = leadingSlot.component({
    ...leadingSlot.options.inject(),
    sessionId: 'session-parent',
    t: (key) => state.dictionaries.en[key] ?? key,
  })
  assert.equal(parentMark, null)

  // Child hover card shows parent title and worktree branch:
  const childHover = hoverSlot.component({
    ...hoverSlot.options.inject(),
    sessionId: 'session-child-1',
    t: (key) => state.dictionaries.en[key] ?? key,
  })
  assert.ok(childHover !== null)
  const hoverText = JSON.stringify(childHover)
  assert.ok(hoverText.includes('Refactor Auth Module'))
  assert.ok(hoverText.includes('task/auth-tests'))
})
