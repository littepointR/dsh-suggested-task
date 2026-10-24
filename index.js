/**
 * Host half of `@local/dsh-suggested-task`.
 *
 * At the end of each completed turn (`agent/turn-stopping`), this plugin asks
 * the session's model for 2–3 concrete follow-up tasks that can be executed in
 * isolated Git worktrees. When `turn/end` commits, those suggestions fold into
 * the client-visible `suggestedTasks` session projection so the Web UI card
 * arrives in the same frame as the completed turn.
 *
 * Clicking "Start" on one task or "Start all" in the Web UI invokes `/tasks`
 * (`start <turn> <taskId>` or `start-all <turn>`), which:
 *   1. Forks the parent session at that completed turn's event boundary so the
 *      child session inherits the full conversation context.
 *   2. Positions the child session directly underneath its parent session in
 *      the Workspace sidebar order.
 *   3. Allocates an isolated Git worktree under `.agents/worktrees/<branch>`
 *      and switches the child session's working directory into it.
 *   4. Titles the child session after the task and admits the task prompt so
 *      the child agent begins working immediately in the background.
 *   5. Returns a structured `command/done` payload that folds into the parent
 *      session's `suggestedTasks` projection, durably linking the parent task
 *      card and the child session across reloads.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Projection key shared with the Client half. */
export const PROJECTION_KEY = 'suggestedTasks'

/**
 * Projection state version. Increment when the persisted state shape changes so
 * `dsh-session-projection-cache` invalidates older cached snapshots cleanly.
 */
export const STATE_VERSION = 1

/** Slash command name used for both manual generation and UI-triggered launches. */
export const COMMAND_NAME = 'tasks'

/** Marker prefix inside `command/done` text so the projection fold recognizes our payloads. */
const COMMAND_PAYLOAD_PREFIX = 'DSH_SUGGESTED_TASKS_V1:'

/**
 * Minimal schema interface required by `ctx.sessionProjections.register()`.
 * Avoids importing the Host's internal `zod` instance directly.
 */
const JSON_SCHEMA = {
  parse(value) {
    return value
  },
  safeParse(value) {
    return { success: true, data: value }
  },
}

const DEFAULTS = Object.freeze({
  enabled: true,
  mode: 'fork',
  maxTasks: 3,
  maxTokens: 1024,
  temperature: 0.3,
  timeoutMs: 15_000,
  maxInputChars: 6_000,
  maxForkChars: 12_000,
  fallback: true,
  skipSubagents: true,
  skipTaskSessions: true,
  worktreePrefix: 'task/',
  worktreeFallback: true,
  provider: undefined,
  model: undefined,
})

const FORK_TRIGGER = 'Suggest follow-up tasks.'

const FORK_INSTRUCTIONS = [
  'The user message "Suggest follow-up tasks." is a synthetic request from the harness UI.',
  'Based on the conversation so far and what was just completed or discussed in the latest turn, propose 2 to {maxTasks} concrete, self-contained follow-up tasks that the user can launch next in isolated Git worktree child sessions.',
  'Good follow-up tasks include: adding or running tests for new changes, handling an edge case or follow-up module, updating documentation/types, verifying build/lint checks, or implementing the next natural step.',
  'Each task should be actionable by an autonomous coding agent working in its own Git worktree.',
  'If the conversation is a trivial greeting or there are no meaningful follow-up tasks, output [] only.',
  'Output ONLY a valid JSON array (no markdown fences, no commentary). Each element must be an object with:',
  '  - "title": concise action title in the same language as the conversation (under 45 chars)',
  '  - "description": one short sentence explaining what the task will do (same language, under 120 chars)',
  '  - "prompt": detailed, self-contained instruction to send to the child session to execute this task (same language)',
  '  - "branch": short lowercase ASCII kebab-case slug for the git branch (2-4 words, e.g. "add-unit-tests", without prefix)',
].join('\n')

const DIGEST_SYSTEM_PROMPT = [
  'You are a follow-up task planner for a coding agent harness.',
  'Given a JSON digest of the latest conversation turn, propose 2 to {maxTasks} concrete, self-contained follow-up tasks that can be executed in isolated Git worktree child sessions.',
  'Good follow-up tasks include: writing or running tests, addressing edge cases, updating related files or docs, running verification checks, or implementing the natural next step.',
  'If the conversation is a trivial greeting or has no meaningful follow-up work, output [] only.',
  'Output ONLY a valid JSON array (no markdown fences, no prose). Each item must have:',
  '  - "title": concise action title in the same language as the user messages (under 45 chars)',
  '  - "description": one short sentence explaining what the task will do (same language, under 120 chars)',
  '  - "prompt": detailed, self-contained instruction for the child agent session to execute the task (same language)',
  '  - "branch": short lowercase ASCII kebab-case slug for the git branch (2-4 words, e.g. "add-unit-tests", without prefix)',
].join('\n')

/**
 * Validate and normalize user-supplied plugin configuration.
 * @param {Record<string, unknown> | undefined} raw
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const intIn = (value, min, max, fallback) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback
  const numIn = (value, min, max, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
  const nonEmptyString = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
  const mode = input.mode === 'fork' || input.mode === 'digest' ? input.mode : DEFAULTS.mode
  const rawPrefix = nonEmptyString(input.worktreePrefix)
  const worktreePrefix = rawPrefix !== undefined
    ? rawPrefix.replace(/[^a-zA-Z0-9/_-]/gu, '').replace(/^\/+/u, '') || DEFAULTS.worktreePrefix
    : DEFAULTS.worktreePrefix

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULTS.enabled,
    mode,
    maxTasks: intIn(input.maxTasks, 1, 5, DEFAULTS.maxTasks),
    maxTokens: intIn(input.maxTokens, 64, 4096, DEFAULTS.maxTokens),
    temperature: numIn(input.temperature, 0, 2, DEFAULTS.temperature),
    timeoutMs: intIn(input.timeoutMs, 500, 60_000, DEFAULTS.timeoutMs),
    maxInputChars: intIn(input.maxInputChars, 500, 20_000, DEFAULTS.maxInputChars),
    maxForkChars: intIn(input.maxForkChars, 1_000, 100_000, DEFAULTS.maxForkChars),
    fallback: typeof input.fallback === 'boolean' ? input.fallback : DEFAULTS.fallback,
    skipSubagents: typeof input.skipSubagents === 'boolean' ? input.skipSubagents : DEFAULTS.skipSubagents,
    skipTaskSessions: typeof input.skipTaskSessions === 'boolean' ? input.skipTaskSessions : DEFAULTS.skipTaskSessions,
    worktreePrefix,
    worktreeFallback: typeof input.worktreeFallback === 'boolean' ? input.worktreeFallback : DEFAULTS.worktreeFallback,
    provider: nonEmptyString(input.provider),
    model: nonEmptyString(input.model),
  }
}

/**
 * Normalize a branch slug into a valid relative Git branch name with the configured prefix.
 * @param {unknown} raw
 * @param {string} [prefix]
 * @param {number} [fallbackIndex]
 * @returns {string}
 */
export function sanitizeBranchSlug(raw, prefix = 'task/', fallbackIndex = 1) {
  const cleanPrefix = typeof prefix === 'string' && prefix.trim() !== ''
    ? prefix.trim().replace(/[^a-zA-Z0-9/_-]/gu, '').replace(/^\/+/u, '')
    : 'task/'
  let body = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (cleanPrefix !== '' && body.startsWith(cleanPrefix.toLowerCase())) {
    body = body.slice(cleanPrefix.length)
  }
  body = body
    .replace(/^refs\/heads\//iu, '')
    .replace(/^(?:task|feat|fix|chore|worktree)\/+/iu, '')
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 40)
    .replace(/-$/gu, '')

  if (body === '') {
    body = `followup-${fallbackIndex}`
  }
  return `${cleanPrefix}${body}`
}

/**
 * Extract a worktree branch name when a path points inside `.agents/worktrees/<branch>`.
 * @param {unknown} cwd
 * @returns {string}
 */
export function extractWorktreeBranch(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return ''
  const normalized = cwd.replace(/\\/gu, '/')
  const marker = '/.agents/worktrees/'
  const idx = normalized.indexOf(marker)
  if (idx === -1) return ''
  const rest = normalized.slice(idx + marker.length).replace(/^\/+|\/+$/gu, '')
  return rest
}

/**
 * Clip a string to a maximum character count without splitting surrogate pairs awkwardly.
 * @param {string} text
 * @param {number} maxChars
 */
function clipText(text, maxChars) {
  const clean = text.trim()
  if (clean.length <= maxChars) return clean
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

/**
 * Normalize one candidate task object into a clean `{ id, title, description, prompt, branch }` entry.
 * @param {unknown} candidate
 * @param {number} index
 * @param {string} worktreePrefix
 */
function normalizeTaskItem(candidate, index, worktreePrefix) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
  const rawTitle = typeof candidate.title === 'string'
    ? candidate.title
    : typeof candidate.name === 'string'
      ? candidate.name
      : ''
  const title = clipText(rawTitle.replace(/\s+/gu, ' '), 80)
  if (title === '') return undefined

  const rawPrompt = typeof candidate.prompt === 'string' && candidate.prompt.trim() !== ''
    ? candidate.prompt
    : typeof candidate.instruction === 'string' && candidate.instruction.trim() !== ''
      ? candidate.instruction
      : typeof candidate.description === 'string' && candidate.description.trim() !== ''
        ? `${title}: ${candidate.description.trim()}`
        : title
  const prompt = clipText(rawPrompt, 1200)
  if (prompt === '') return undefined

  const rawDescription = typeof candidate.description === 'string' && candidate.description.trim() !== ''
    ? candidate.description
    : typeof candidate.summary === 'string' && candidate.summary.trim() !== ''
      ? candidate.summary
      : prompt
  const description = clipText(rawDescription.replace(/\s+/gu, ' '), 200)

  const branchSource = typeof candidate.branch === 'string' && candidate.branch.trim() !== ''
    ? candidate.branch
    : typeof candidate.slug === 'string' && candidate.slug.trim() !== ''
      ? candidate.slug
      : title
  const branch = sanitizeBranchSlug(branchSource, worktreePrefix, index + 1)

  return {
    id: `t${index + 1}`,
    title,
    description,
    prompt,
    branch,
  }
}

/**
 * Parse the LLM output into up to `maxTasks` normalized follow-up task items.
 * Accepts raw JSON arrays, `{ "tasks": [...] }` objects, fenced JSON blocks, or
 * markdown bullet fallbacks.
 *
 * @param {string} raw
 * @param {number} [maxTasks]
 * @param {string} [worktreePrefix]
 */
export function parseSuggestedTasks(raw, maxTasks = DEFAULTS.maxTasks, worktreePrefix = DEFAULTS.worktreePrefix) {
  if (typeof raw !== 'string') return []
  let text = raw.trim()
  if (text === '' || /^(?:none|null|n\/a|\[\])$/iu.test(text)) return []

  // Strip optional markdown code fences.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)
  if (fenced?.[1] !== undefined) {
    text = fenced[1].trim()
  }

  let parsedList
  const tryJson = (snippet) => {
    try {
      const value = JSON.parse(snippet)
      if (Array.isArray(value)) return value
      if (value !== null && typeof value === 'object' && Array.isArray(value.tasks)) return value.tasks
      if (value !== null && typeof value === 'object' && typeof value.title === 'string') return [value]
    } catch {
      // Fall through to bracket extraction.
    }
    return undefined
  }

  parsedList = tryJson(text)
  if (parsedList === undefined) {
    const startArr = text.indexOf('[')
    const endArr = text.lastIndexOf(']')
    if (startArr !== -1 && endArr > startArr) {
      parsedList = tryJson(text.slice(startArr, endArr + 1))
    }
  }
  if (parsedList === undefined) {
    const startObj = text.indexOf('{')
    const endObj = text.lastIndexOf('}')
    if (startObj !== -1 && endObj > startObj) {
      parsedList = tryJson(text.slice(startObj, endObj + 1))
    }
  }

  const results = []
  const seenTitles = new Set()
  const usedBranches = new Set()

  if (Array.isArray(parsedList)) {
    for (const item of parsedList) {
      if (results.length >= maxTasks) break
      const normalized = normalizeTaskItem(item, results.length, worktreePrefix)
      if (normalized === undefined) continue
      const titleKey = normalized.title.toLowerCase()
      if (seenTitles.has(titleKey)) continue
      seenTitles.add(titleKey)

      let branch = normalized.branch
      let suffix = 2
      while (usedBranches.has(branch)) {
        branch = `${normalized.branch}-${suffix}`
        suffix += 1
      }
      usedBranches.add(branch)
      results.push({ ...normalized, branch })
    }
  }

  return results
}

/**
 * Encode a structured command result so `command/done` can fold it into the projection.
 * @param {Record<string, unknown>} payload
 */
export function encodeCommandPayload(payload) {
  return `${COMMAND_PAYLOAD_PREFIX}${JSON.stringify(payload)}`
}

/**
 * Decode a structured command result from `command/done` text, if it came from this plugin.
 * @param {unknown} text
 */
export function parseCommandPayload(text) {
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

/**
 * Concatenate plain text blocks from a message content array.
 * @param {unknown} content
 */
function textFromContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const trimmed = block.text.trim()
      if (trimmed !== '') parts.push(trimmed)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Read the events array from a session, supporting both `ownEvents()` and `snapshotEvents()`.
 * @param {any} session
 */
function readSessionEvents(session) {
  if (typeof session?.ownEvents === 'function') {
    const events = session.ownEvents()
    if (Array.isArray(events)) return events
  }
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    if (Array.isArray(events)) return events
  }
  return []
}

/**
 * Collect the newest human messages and assistant replies from the session log.
 * @param {any} session
 * @param {number} [maxUsers]
 * @param {number} [maxReplies]
 */
export function recentDialogue(session, maxUsers = 3, maxReplies = 2) {
  const events = readSessionEvents(session)
  const users = []
  const replies = []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message' && users.length < maxUsers) {
      const text = textFromContent(event.data?.content)
      if (text !== '') users.unshift(text)
    } else if (event?.type === 'assistant/message' && replies.length < maxReplies) {
      const text = textFromContent(event.data?.message?.content)
      if (text !== '') replies.unshift(text)
    }
    if (users.length >= maxUsers && replies.length >= maxReplies) break
  }
  return { users, replies }
}

/**
 * Collect distinct tool names invoked during a specific turn.
 * @param {any} session
 * @param {number} turn
 */
export function toolsForTurn(session, turn) {
  const events = readSessionEvents(session)
  let startIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) {
      startIndex = index
      break
    }
  }
  if (startIndex < 0) return []
  const names = []
  const seen = new Set()
  for (let index = startIndex + 1; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/start') break
    if (event?.type === 'tool/call') {
      const name = event.data?.name
      if (typeof name === 'string' && name !== '' && !seen.has(name)) {
        seen.add(name)
        names.push(name)
      }
    }
  }
  return names
}

/**
 * Find the latest turn number in a session log.
 * @param {any} session
 * @returns {number | undefined}
 */
export function latestTurn(session) {
  const events = readSessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if ((event?.type === 'turn/end' || event?.type === 'turn/start') && typeof event.data?.turn === 'number') {
      return event.data.turn
    }
  }
  return undefined
}

/**
 * Find the exact inclusive `seq` for a completed turn's `turn/end` event.
 * @param {any} session
 * @param {number} turn
 * @returns {number | undefined}
 */
export function turnEndSeq(session, turn) {
  const events = readSessionEvents(session)
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end' && event.data?.turn === turn && typeof event.seq === 'number') {
      return event.seq
    }
  }
  return undefined
}

/**
 * Build the compact JSON digest input for digest-mode task generation.
 * @param {any} session
 * @param {number} turn
 * @param {ReturnType<typeof resolveConfig>} config
 */
export function buildDigestInput(session, turn, config) {
  const { users, replies } = recentDialogue(session, 3, 2)
  if (users.length === 0) return undefined
  const perUserBudget = Math.max(200, Math.floor((config.maxInputChars * 0.45) / users.length))
  const replyBudget = Math.max(300, Math.floor(config.maxInputChars * 0.45))
  const latestReply = replies.at(-1)
  return JSON.stringify(
    {
      recent_user_messages: users.map((text) => clipText(text, perUserBudget)),
      latest_assistant_reply: latestReply !== undefined ? clipText(latestReply, replyBudget) : undefined,
      tools_used: toolsForTurn(session, turn).slice(0, 16),
    },
    null,
    2,
  )
}

/**
 * Build the parent-transcript fork context (`system` + text-only `messages` + synthetic trigger).
 * Preserves assistant `source` metadata so provider adapters with `replayState` succeed.
 *
 * @param {any} session
 * @param {ReturnType<typeof resolveConfig>} config
 */
export function buildForkContext(session, config) {
  if (typeof session?.deriveMessages !== 'function') return undefined
  const derived = session.deriveMessages()
  if (!Array.isArray(derived) || derived.length === 0) return undefined

  const systemParts = []
  const dialogue = []
  for (const message of derived) {
    if (message?.role === 'system' || message?.role === 'developer') {
      const text = textFromContent(message.content)
      if (text !== '') systemParts.push(text)
      continue
    }
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const textBlocks = Array.isArray(message.content)
      ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
      : []
    if (textBlocks.length === 0) continue
    const chars = textBlocks.reduce((sum, block) => sum + block.text.length, 0)
    dialogue.push({
      message: message.role === 'assistant'
        ? { ...message, content: textBlocks }
        : { role: 'user', content: textBlocks },
      chars,
    })
  }

  if (!dialogue.some((entry) => entry.message.role === 'user')) return undefined

  const kept = []
  let usedChars = 0
  for (let index = dialogue.length - 1; index >= 0; index -= 1) {
    const entry = dialogue[index]
    if (kept.length > 0 && usedChars + entry.chars > config.maxForkChars) break
    kept.unshift(entry.message)
    usedChars += entry.chars
  }
  while (kept.length > 0 && kept[0].role !== 'user') {
    kept.shift()
  }
  if (kept.length === 0) return undefined

  const instructions = FORK_INSTRUCTIONS.replace('{maxTasks}', String(config.maxTasks))
  const system = systemParts.length > 0 ? `${systemParts.join('\n\n')}\n\n${instructions}` : instructions

  return {
    system,
    messages: [
      ...kept,
      { role: 'user', content: [{ type: 'text', text: FORK_TRIGGER }] },
    ],
  }
}

/**
 * Select the lowest reasoning effort when the model supports reasoning controls.
 * @param {Record<string, unknown>} base
 * @param {any} modelInfo
 */
function applyLowReasoning(base, modelInfo) {
  const efforts = modelInfo?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return base
  const low = efforts.find((effort) => effort?.id === 'low') ?? efforts[0]
  return typeof low?.id === 'string' ? { ...base, reasoningEffort: low.id } : base
}

/**
 * Execute one streaming LLM call and collect its text output.
 * @param {any} llm
 * @param {{ provider: string, model: string }} route
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {{ system: string, messages: Array<any> }} prompt
 * @param {AbortSignal | undefined} outerSignal
 */
async function runLlmRequest(llm, route, config, prompt, outerSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), config.timeoutMs)
  if (typeof timer?.unref === 'function') timer.unref()
  const signal = outerSignal !== undefined ? AbortSignal.any([outerSignal, controller.signal]) : controller.signal

  try {
    const call = await llm.prepareCall(
      {
        provider: route.provider,
        model: route.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      },
      signal,
      applyLowReasoning,
    )
    let raw = ''
    let finishReason
    for await (const chunk of call.stream({
      system: prompt.system,
      messages: prompt.messages,
      tools: [],
      signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        raw += chunk.text
      } else if (chunk?.type === 'finish') {
        finishReason = chunk.reason
      }
    }
    if (finishReason?.kind === 'error') {
      const code = finishReason.failure?.code ?? 'error'
      return { ok: false, reason: `provider:${code}`, model: call.config?.model ?? route.model }
    }
    if (finishReason?.kind === 'aborted') {
      const reason = controller.signal.aborted ? 'timeout' : 'aborted'
      return { ok: false, reason, model: call.config?.model ?? route.model }
    }
    const tasks = parseSuggestedTasks(raw, config.maxTasks, config.worktreePrefix)
    const model = call.config?.model ?? route.model
    if (tasks.length === 0) {
      return { ok: false, reason: 'empty', model }
    }
    return { ok: true, tasks, model }
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: false, reason: 'timeout', model: route.model }
    }
    if (outerSignal?.aborted) {
      return { ok: false, reason: 'aborted', model: route.model }
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `error:${clipText(message, 60)}`, model: route.model }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Generate follow-up task suggestions for a turn using fork mode and/or digest mode.
 * @param {any} llm
 * @param {any} session
 * @param {number} turn
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {AbortSignal | undefined} signal
 */
export async function generateSuggestionsForTurn(llm, session, turn, config, signal) {
  const headerConfig = session?.requestHeader?.()?.config
  const provider = config.provider ?? headerConfig?.provider
  const model = config.model ?? headerConfig?.model
  if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
    return { ok: false, reason: 'no-model', model: '' }
  }
  const route = { provider, model }
  const reasons = []

  if (config.mode === 'fork') {
    const forkContext = buildForkContext(session, config)
    if (forkContext !== undefined) {
      const result = await runLlmRequest(llm, route, config, forkContext, signal)
      if (result.ok) {
        return { ok: true, tasks: result.tasks, model: result.model, mode: 'fork' }
      }
      reasons.push(`fork:${result.reason}`)
      if (!config.fallback) {
        return { ok: false, reason: reasons.join(';'), model: result.model }
      }
    } else {
      reasons.push('fork:no-context')
      if (!config.fallback) {
        return { ok: false, reason: reasons.join(';'), model }
      }
    }
  }

  const digest = buildDigestInput(session, turn, config)
  if (digest === undefined) {
    reasons.push('digest:no-input')
    return { ok: false, reason: reasons.join(';'), model }
  }
  const digestPrompt = {
    system: DIGEST_SYSTEM_PROMPT.replace('{maxTasks}', String(config.maxTasks)),
    messages: [{ role: 'user', content: [{ type: 'text', text: digest }] }],
  }
  const digestResult = await runLlmRequest(llm, route, config, digestPrompt, signal)
  if (digestResult.ok) {
    return { ok: true, tasks: digestResult.tasks, model: digestResult.model, mode: 'digest' }
  }
  reasons.push(`digest:${digestResult.reason}`)
  return { ok: false, reason: reasons.join(';'), model: digestResult.model }
}

/**
 * Default `git` command runner using `node:child_process.execFile`.
 * @param {string} cwd
 * @param {string[]} args
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function defaultExecGit(cwd, args, signal) {
  return new Promise((resolve, reject) => {
    execFileCallback(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { cwd, signal, windowsHide: true, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (typeof error.code === 'number') {
            resolve({ exitCode: error.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
            return
          }
          reject(error)
          return
        }
        resolve({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/**
 * Check whether a filesystem path already exists.
 * @param {string} targetPath
 */
async function pathExists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

/**
 * Allocate an isolated Git worktree under `<repoRoot>/.agents/worktrees/<branch>`
 * and switch `childAgent`'s working directory to it.
 *
 * Uses `ctx.get('worktrees').create(...)` when the experimental worktree service
 * is mounted, and otherwise performs the equivalent Git worktree creation directly.
 *
 * @param {any} ctx
 * @param {any} childAgent
 * @param {string} baseCwd
 * @param {string} desiredBranch
 * @param {AbortSignal | undefined} signal
 * @param {typeof defaultExecGit} [execGit]
 */
export async function createGitWorktree(ctx, childAgent, baseCwd, desiredBranch, signal, execGit = defaultExecGit) {
  const worktreeService = ctx?.get?.('worktrees')
  if (worktreeService !== undefined && typeof worktreeService.create === 'function' && childAgent !== undefined) {
    let lastError
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const candidate = attempt === 1 ? desiredBranch : `${desiredBranch}-${attempt}`
      try {
        const created = await worktreeService.create(childAgent, { name: candidate }, signal)
        return {
          path: created.path,
          branch: created.branch ?? candidate,
          baseCommit: created.baseCommit ?? '',
          repositoryRoot: created.repositoryRoot ?? '',
          fallback: false,
        }
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (!/already exists/iu.test(message)) break
      }
    }
    throw lastError
  }

  const workingDirService = ctx?.get?.('workingDirectory')
  let cwd = baseCwd
  if ((typeof cwd !== 'string' || cwd === '') && workingDirService !== undefined && typeof workingDirService.ensure === 'function' && childAgent !== undefined) {
    cwd = await workingDirService.ensure(childAgent, signal)
  }
  if (typeof cwd !== 'string' || cwd === '') {
    cwd = childAgent?.session?.header?.cwd ?? process.cwd()
  }

  const topLevel = await execGit(cwd, ['rev-parse', '--show-toplevel'], signal)
  if (topLevel.exitCode !== 0 || topLevel.stdout.trim() === '') {
    throw new Error(topLevel.stderr.trim() || `Not a git repository: ${cwd}`)
  }
  const repositoryRoot = path.resolve(cwd, topLevel.stdout.trim())

  const commitRes = await execGit(repositoryRoot, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], signal)
  if (commitRes.exitCode !== 0 || commitRes.stdout.trim() === '') {
    throw new Error(commitRes.stderr.trim() || 'Repository has no HEAD commit to branch a worktree from')
  }
  const baseCommit = commitRes.stdout.trim()

  const poolPath = path.join(repositoryRoot, '.agents', 'worktrees')
  await mkdir(poolPath, { recursive: true })
  try {
    await writeFile(path.join(poolPath, '.gitignore'), '*\n', { flag: 'wx' })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  let selectedBranch = desiredBranch
  let destinationPath = path.join(poolPath, ...desiredBranch.split('/'))
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const candidate = attempt === 1
      ? desiredBranch
      : attempt <= 10
        ? `${desiredBranch}-${attempt}`
        : `${desiredBranch}-${randomUUID().slice(0, 6)}`
    const refCheck = await execGit(repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], signal)
    const candidatePath = path.join(poolPath, ...candidate.split('/'))
    if (refCheck.exitCode !== 0 && !(await pathExists(candidatePath))) {
      selectedBranch = candidate
      destinationPath = candidatePath
      break
    }
  }

  await mkdir(path.dirname(destinationPath), { recursive: true })
  const addRes = await execGit(
    repositoryRoot,
    ['worktree', 'add', '-b', selectedBranch, '--', destinationPath, baseCommit],
    signal,
  )
  if (addRes.exitCode !== 0) {
    throw new Error(addRes.stderr.trim() || `git worktree add failed for ${selectedBranch}`)
  }

  let finalPath = destinationPath
  if (workingDirService !== undefined && typeof workingDirService.set === 'function' && childAgent !== undefined) {
    finalPath = await workingDirService.set(childAgent, destinationPath, signal)
  }

  return {
    path: finalPath,
    branch: selectedBranch,
    baseCommit,
    repositoryRoot,
    fallback: false,
  }
}

/**
 * Position a newly forked child session right underneath its parent session
 * (and after any already-created sibling task sessions of that parent) in the
 * Workspace's ordered session list.
 *
 * @param {any} ctx
 * @param {string} parentSessionId
 * @param {string} childSessionId
 * @param {Map<string, any>} knownChildMeta
 */
async function positionChildInWorkspace(ctx, parentSessionId, childSessionId, knownChildMeta) {
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return
    const workspaces = registry.list()
    if (!Array.isArray(workspaces)) return
    const workspace = workspaces.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(parentSessionId))
    if (workspace === undefined || typeof workspace.insertSessionBefore !== 'function') return

    const ids = workspace.sessionIds.filter((id) => id !== childSessionId)
    const parentIndex = ids.indexOf(parentSessionId)
    if (parentIndex === -1) return

    let anchorIndex = parentIndex + 1
    while (anchorIndex < ids.length) {
      const candidateId = ids[anchorIndex]
      const meta = knownChildMeta.get(candidateId)
      if (meta?.parentSessionId === parentSessionId) {
        anchorIndex += 1
        continue
      }
      break
    }
    const beforeSessionId = anchorIndex < ids.length ? ids[anchorIndex] : undefined
    await workspace.insertSessionBefore(childSessionId, beforeSessionId)
  } catch {
    // Workspace ordering is a presentation enhancement; never fail task launch over it.
  }
}

/**
 * Compose the initial user prompt sent to the forked child session.
 * @param {{ title: string, description: string, prompt: string }} task
 * @param {{ path: string, branch: string, fallback?: boolean }} worktree
 */
function buildChildTaskPrompt(task, worktree) {
  if (worktree.branch !== '' && worktree.path !== '' && !worktree.fallback) {
    return [
      `[Sub-session task: ${task.title} | Git worktree branch: \`${worktree.branch}\` | Working directory: \`${worktree.path}\`]`,
      '',
      task.prompt,
    ].join('\n')
  }
  return task.prompt
}

/**
 * Host plugin entrypoint.
 * @param {any} ctx
 * @param {Record<string, unknown> | undefined} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  /**
   * Pending suggestions generated during `agent/turn-stopping`, keyed by `${sessionId}:${turn}`.
   * Consumed when the matching `turn/end` event folds into the projection.
   */
  const pendingByTurn = new Map()

  /**
   * In-flight deduplication set for `agent/turn-stopping` (since both root and
   * agent-scoped listeners may fire for the same turn).
   */
  const inFlightTurns = new Set()

  /**
   * Authoritative mirror of each session's latest projection state so `/tasks`
   * commands can look up turn tasks even when `ctx.sessionProjections.snapshot`
   * is not exposed on a minimal test double.
   */
  const statesBySession = new Map()

  /**
   * Known child-session metadata keyed by `childSessionId`, populated as soon
   * as a task is forked so the child's projection cell carries its parent link
   * and worktree metadata immediately.
   */
  const knownChildMeta = new Map()

  /**
   * Optional custom git executor injectable via `rawConfig.__execGit` in tests.
   */
  const execGit = typeof rawConfig?.__execGit === 'function' ? rawConfig.__execGit : defaultExecGit

  const turnKey = (sessionId, turn) => `${sessionId}:${turn}`

  const isTaskChildSession = (session) => {
    const id = session?.id ?? session?.header?.id
    if (typeof id === 'string' && knownChildMeta.has(id)) return true
    if (typeof id === 'string' && statesBySession.get(id)?.childOf !== null && statesBySession.get(id)?.childOf !== undefined) {
      return true
    }
    return false
  }

  /**
   * Run suggestion generation before `turn/end` commits.
   * @param {any} scopedCtx
   * @param {any} event
   */
  async function handleTurnStopping(scopedCtx, event) {
    const session = event?.agent?.session
    const turn = event?.turn
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId !== 'string' || sessionId === '' || typeof turn !== 'number') return
    if (config.skipSubagents && session?.header?.origin === 'subagent') return
    if (config.skipTaskSessions && isTaskChildSession(session)) return

    const key = turnKey(sessionId, turn)
    if (inFlightTurns.has(key) || pendingByTurn.has(key)) return
    inFlightTurns.add(key)

    try {
      const llm = scopedCtx?.get?.('llm') ?? scopedCtx?.llm ?? ctx?.get?.('llm')
      if (llm === undefined || typeof llm.prepareCall !== 'function') return
      const outcome = await generateSuggestionsForTurn(llm, session, turn, config, event?.signal)
      pendingByTurn.set(key, {
        ...outcome,
        at: Date.now(),
      })
    } catch (error) {
      const logger = scopedCtx?.logger ?? ctx?.logger
      logger?.warn?.(`suggested-task: turn ${turn} suggestion failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      inFlightTurns.delete(key)
    }
  }

  /**
   * Read the current projection state for `session`.
   * @param {any} scopedCtx
   * @param {any} session
   */
  function currentSessionState(scopedCtx, session) {
    const sessionId = session?.id ?? session?.header?.id
    try {
      const projections = scopedCtx?.get?.('sessionProjections') ?? scopedCtx?.sessionProjections
      if (projections !== undefined && typeof projections.snapshot === 'function') {
        const snap = projections.snapshot(session)
        if (snap?.values?.[PROJECTION_KEY] !== undefined) {
          return snap.values[PROJECTION_KEY]
        }
      }
    } catch {
      // Fall back to in-memory state mirror.
    }
    return typeof sessionId === 'string' ? statesBySession.get(sessionId) : undefined
  }

  /**
   * Fork the parent session, create an isolated Git worktree, rename the child,
   * and start the task prompt in the child session.
   *
   * @param {any} scopedCtx
   * @param {any} parentAgent
   * @param {number} turn
   * @param {{ id: string, title: string, description: string, prompt: string, branch: string }} task
   * @param {AbortSignal | undefined} signal
   */
  async function launchSingleTask(scopedCtx, parentAgent, turn, task, signal) {
    const parentSession = parentAgent?.session
    const parentSessionId = parentSession?.id ?? parentSession?.header?.id
    if (typeof parentSessionId !== 'string' || parentSessionId === '') {
      throw new Error('Parent session identity is unavailable.')
    }

    const sessionController = scopedCtx?.get?.('sessionController') ?? ctx?.get?.('sessionController')
    if (sessionController === undefined || typeof sessionController.fork !== 'function') {
      throw new Error('sessionController.fork is unavailable in this runtime.')
    }

    const atSeq = turnEndSeq(parentSession, turn)
    const forkResult = await sessionController.fork({
      sessionId: parentSessionId,
      ...(atSeq !== undefined ? { atSeq } : {}),
    })
    const childSessionId = forkResult?.sessionId
    if (typeof childSessionId !== 'string' || childSessionId === '') {
      throw new Error('Failed to fork a child session for the suggested task.')
    }

    const initialChildMeta = {
      parentSessionId,
      parentTurn: turn,
      taskId: task.id,
      title: task.title,
      description: task.description,
      branch: task.branch,
      worktreePath: '',
    }
    knownChildMeta.set(childSessionId, initialChildMeta)

    await positionChildInWorkspace(scopedCtx, parentSessionId, childSessionId, knownChildMeta)

    let childAgent = scopedCtx?.get?.('agents')?.get?.(childSessionId) ?? ctx?.get?.('agents')?.get?.(childSessionId)
    if (childAgent === undefined && typeof sessionController.resolveAgent === 'function') {
      const resolved = await sessionController.resolveAgent(childSessionId)
      childAgent = resolved?.agent ?? resolved
    }

    const parentCwd = parentSession?.header?.cwd ?? ''
    let worktreeInfo = {
      path: parentCwd,
      branch: task.branch,
      baseCommit: '',
      repositoryRoot: '',
      fallback: false,
    }
    try {
      worktreeInfo = await createGitWorktree(scopedCtx, childAgent, parentCwd, task.branch, signal, execGit)
    } catch (error) {
      if (!config.worktreeFallback) {
        throw error
      }
      const logger = scopedCtx?.logger ?? ctx?.logger
      logger?.warn?.(
        `suggested-task: git worktree creation fell back to parent cwd for "${task.title}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      worktreeInfo = {
        path: parentCwd,
        branch: '',
        baseCommit: '',
        repositoryRoot: '',
        fallback: true,
      }
    }

    const finalChildMeta = {
      ...initialChildMeta,
      branch: worktreeInfo.branch,
      worktreePath: worktreeInfo.path,
    }
    knownChildMeta.set(childSessionId, finalChildMeta)
    const existingChildState = statesBySession.get(childSessionId)
    if (existingChildState !== undefined) {
      statesBySession.set(childSessionId, {
        ...existingChildState,
        childOf: finalChildMeta,
      })
    }

    // Rename the child session before admitting the first prompt so its title is
    // the task's title rather than "Parent (1)" or an auto-generated title.
    try {
      if (typeof sessionController.rename === 'function') {
        await sessionController.rename({ sessionId: childSessionId, title: task.title })
      } else {
        const titleService = scopedCtx?.get?.('sessionTitle') ?? ctx?.get?.('sessionTitle')
        if (titleService !== undefined && typeof titleService.rename === 'function' && childAgent?.session !== undefined) {
          titleService.rename(childAgent.session, task.title)
        }
      }
    } catch (error) {
      const logger = scopedCtx?.logger ?? ctx?.logger
      logger?.warn?.(`suggested-task: could not rename child session ${childSessionId}: ${error instanceof Error ? error.message : String(error)}`)
    }

    const promptText = buildChildTaskPrompt(task, worktreeInfo)
    if (typeof sessionController.prompt === 'function') {
      await sessionController.prompt(
        {
          sessionId: childSessionId,
          requestId: `suggested-task-${randomUUID()}`,
          content: [{ type: 'text', text: promptText }],
          mode: 'followup',
        },
        signal,
      )
    } else if (typeof childAgent?.followup === 'function') {
      childAgent.followup({
        role: 'user',
        content: [{ type: 'text', text: promptText }],
      })
    }

    return {
      taskId: task.id,
      sessionId: childSessionId,
      title: task.title,
      branch: worktreeInfo.branch,
      worktreePath: worktreeInfo.path,
      startedAt: Date.now(),
    }
  }

  /**
   * Handle `/tasks` invocations:
   * - `/tasks` or `/tasks generate [turn]`: generate/regenerate suggestions for a turn
   * - `/tasks start <turn> <taskId>`: start one suggested task in a new worktree child session
   * - `/tasks start-all [turn]`: start all unstarted suggested tasks of a turn in parallel worktree child sessions
   */
  async function handleTasksCommand(scopedCtx, invocation) {
    const agent = invocation?.agent
    const session = agent?.session
    const sessionId = session?.id ?? session?.header?.id
    if (typeof sessionId !== 'string' || sessionId === '') {
      return { kind: 'error', text: 'No active session.' }
    }

    const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : ''
    const tokens = raw === '' ? [] : raw.split(/\s+/u)
    const subcommand = tokens[0]?.toLowerCase() ?? 'generate'

    if (subcommand === 'start') {
      const turn = Number.parseInt(tokens[1] ?? '', 10)
      const taskId = tokens[2] ?? ''
      if (!Number.isInteger(turn) || turn <= 0 || taskId === '') {
        return { kind: 'error', text: 'Usage: /tasks start <turn> <taskId>' }
      }
      const state = currentSessionState(scopedCtx, session)
      const turnEntry = state?.turns?.[String(turn)]
      if (turnEntry === undefined || !Array.isArray(turnEntry.tasks)) {
        return { kind: 'error', text: `No suggested tasks found for turn ${turn}.` }
      }
      const existing = turnEntry.started?.[taskId]
      if (existing !== undefined && typeof existing.sessionId === 'string' && existing.sessionId !== '') {
        return {
          kind: 'success',
          text: encodeCommandPayload({
            action: 'started',
            turn,
            started: [existing],
          }),
        }
      }
      const task = turnEntry.tasks.find((item) => item.id === taskId)
      if (task === undefined) {
        return { kind: 'error', text: `Task "${taskId}" was not found in turn ${turn}.` }
      }
      try {
        const record = await launchSingleTask(scopedCtx, agent, turn, task, invocation.signal)
        return {
          kind: 'success',
          text: encodeCommandPayload({
            action: 'started',
            turn,
            started: [record],
          }),
        }
      } catch (error) {
        return {
          kind: 'error',
          text: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (subcommand === 'start-all') {
      const explicitTurn = tokens[1] !== undefined ? Number.parseInt(tokens[1], 10) : undefined
      const turn = Number.isInteger(explicitTurn) && explicitTurn > 0 ? explicitTurn : latestTurn(session)
      if (typeof turn !== 'number') {
        return { kind: 'error', text: 'No completed turn found to start tasks from.' }
      }
      const state = currentSessionState(scopedCtx, session)
      const turnEntry = state?.turns?.[String(turn)]
      if (turnEntry === undefined || !Array.isArray(turnEntry.tasks) || turnEntry.tasks.length === 0) {
        return { kind: 'error', text: `No suggested tasks found for turn ${turn}.` }
      }
      const unstarted = turnEntry.tasks.filter((task) => !turnEntry.started?.[task.id]?.sessionId)
      if (unstarted.length === 0) {
        return {
          kind: 'success',
          text: encodeCommandPayload({
            action: 'started',
            turn,
            started: Object.values(turnEntry.started ?? {}),
          }),
        }
      }
      const started = []
      const errors = []
      for (const task of unstarted) {
        try {
          const record = await launchSingleTask(scopedCtx, agent, turn, task, invocation.signal)
          started.push(record)
        } catch (error) {
          errors.push(`${task.title}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (started.length === 0 && errors.length > 0) {
        return { kind: 'error', text: errors.join('; ') }
      }
      return {
        kind: 'success',
        text: encodeCommandPayload({
          action: 'started',
          turn,
          started,
          ...(errors.length > 0 ? { warnings: errors } : {}),
        }),
      }
    }

    // Default / `generate`: compute or recompute suggested tasks for the target or latest turn.
    const explicitTurn = subcommand === 'generate' && tokens[1] !== undefined
      ? Number.parseInt(tokens[1], 10)
      : Number.parseInt(subcommand, 10)
    const turn = Number.isInteger(explicitTurn) && explicitTurn > 0 ? explicitTurn : latestTurn(session)
    if (typeof turn !== 'number') {
      return { kind: 'error', text: 'Finish at least one conversation turn before generating suggested tasks.' }
    }
    const llm = scopedCtx?.get?.('llm') ?? scopedCtx?.llm ?? ctx?.get?.('llm')
    if (llm === undefined || typeof llm.prepareCall !== 'function') {
      return { kind: 'error', text: 'LLM service is unavailable.' }
    }
    const outcome = await generateSuggestionsForTurn(llm, session, turn, config, invocation.signal)
    if (!outcome.ok) {
      return { kind: 'error', text: `Could not generate suggested tasks (${outcome.reason}).` }
    }
    return {
      kind: 'success',
      text: encodeCommandPayload({
        action: 'generated',
        turn,
        tasks: outcome.tasks,
        model: outcome.model,
        mode: outcome.mode,
        at: Date.now(),
      }),
    }
  }

  ctx.inject(['sessionProjections'], (scoped) => {
    scoped.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: STATE_VERSION,
      stateSchema: JSON_SCHEMA,

      init(header, inheritedEventCount) {
        const sessionId = typeof header?.id === 'string' ? header.id : ''
        const parentSessionId = typeof header?.parentSession === 'string' ? header.parentSession : ''
        const inherited = typeof inheritedEventCount === 'number' && inheritedEventCount > 0 ? inheritedEventCount : 0
        const knownChild = sessionId !== '' ? knownChildMeta.get(sessionId) ?? null : null
        const initial = {
          sessionId,
          parentSessionId,
          inheritedEventCount: inherited,
          childOf: knownChild,
          turns: {},
          lastFailure: undefined,
        }
        if (sessionId !== '') {
          statesBySession.set(sessionId, initial)
        }
        return initial
      },

      apply(state, event) {
        const sessionId = state.sessionId
        const knownChild = sessionId !== '' ? knownChildMeta.get(sessionId) : undefined
        let nextState = state
        if (knownChild !== undefined && state.childOf !== knownChild) {
          nextState = { ...nextState, childOf: knownChild }
        }

        // In a forked child session, events before `inheritedEventCount` belong
        // to the parent transcript prefix and must not re-populate parent cards.
        if (
          nextState.inheritedEventCount > 0
          && typeof event?.seq === 'number'
          && event.seq < nextState.inheritedEventCount
        ) {
          if (nextState !== state && sessionId !== '') statesBySession.set(sessionId, nextState)
          return nextState
        }

        if (event?.type === 'working-directory/change') {
          const cwd = event.data?.cwd
          if (typeof cwd === 'string' && cwd !== '' && nextState.parentSessionId !== '') {
            const branch = extractWorktreeBranch(cwd)
            if (branch !== '' || nextState.childOf !== null) {
              const updatedChildOf = {
                parentSessionId: nextState.childOf?.parentSessionId ?? nextState.parentSessionId,
                parentTurn: nextState.childOf?.parentTurn ?? 0,
                taskId: nextState.childOf?.taskId ?? '',
                title: nextState.childOf?.title ?? '',
                description: nextState.childOf?.description ?? '',
                branch: branch !== '' ? branch : (nextState.childOf?.branch ?? ''),
                worktreePath: cwd,
              }
              nextState = { ...nextState, childOf: updatedChildOf }
              if (sessionId !== '') {
                knownChildMeta.set(sessionId, updatedChildOf)
                statesBySession.set(sessionId, nextState)
              }
            }
          }
          return nextState
        }

        if (event?.type === 'session/title') {
          const title = event.data?.title
          if (typeof title === 'string' && title !== '' && nextState.childOf !== null) {
            const updatedChildOf = {
              ...nextState.childOf,
              title,
            }
            nextState = { ...nextState, childOf: updatedChildOf }
            if (sessionId !== '') {
              knownChildMeta.set(sessionId, updatedChildOf)
              statesBySession.set(sessionId, nextState)
            }
          }
          return nextState
        }

        if (event?.type === 'turn/end') {
          const turn = event.data?.turn
          const reasonKind = event.data?.reason?.kind
          if (typeof turn !== 'number') return nextState
          const key = turnKey(sessionId, turn)
          const pending = pendingByTurn.get(key)
          pendingByTurn.delete(key)

          if (reasonKind !== 'completed' || pending === undefined) {
            if (nextState !== state && sessionId !== '') statesBySession.set(sessionId, nextState)
            return nextState
          }

          if (!pending.ok || !Array.isArray(pending.tasks) || pending.tasks.length === 0) {
            nextState = {
              ...nextState,
              lastFailure: {
                turn,
                reason: pending.reason ?? 'empty',
                at: pending.at ?? Date.now(),
              },
            }
            if (sessionId !== '') statesBySession.set(sessionId, nextState)
            return nextState
          }

          const prevTurnEntry = nextState.turns[String(turn)]
          const turnEntry = {
            turn,
            tasks: pending.tasks,
            model: pending.model ?? '',
            mode: pending.mode ?? config.mode,
            at: pending.at ?? Date.now(),
            started: prevTurnEntry?.started ?? {},
          }
          nextState = {
            ...nextState,
            turns: {
              ...nextState.turns,
              [String(turn)]: turnEntry,
            },
          }
          if (sessionId !== '') statesBySession.set(sessionId, nextState)
          return nextState
        }

        if (event?.type === 'command/done' && event.data?.kind === 'success') {
          const payload = parseCommandPayload(event.data?.text)
          if (payload === undefined) return nextState

          if (payload.action === 'generated' && typeof payload.turn === 'number' && Array.isArray(payload.tasks)) {
            const turnStr = String(payload.turn)
            const prevTurnEntry = nextState.turns[turnStr]
            const turnEntry = {
              turn: payload.turn,
              tasks: payload.tasks,
              model: typeof payload.model === 'string' ? payload.model : '',
              mode: typeof payload.mode === 'string' ? payload.mode : config.mode,
              at: typeof payload.at === 'number' ? payload.at : Date.now(),
              started: prevTurnEntry?.started ?? {},
            }
            nextState = {
              ...nextState,
              turns: {
                ...nextState.turns,
                [turnStr]: turnEntry,
              },
            }
            if (sessionId !== '') statesBySession.set(sessionId, nextState)
            return nextState
          }

          if (payload.action === 'started' && typeof payload.turn === 'number' && Array.isArray(payload.started)) {
            const turnStr = String(payload.turn)
            const prevTurnEntry = nextState.turns[turnStr] ?? {
              turn: payload.turn,
              tasks: [],
              model: '',
              mode: config.mode,
              at: Date.now(),
              started: {},
            }
            const nextStarted = { ...prevTurnEntry.started }
            for (const record of payload.started) {
              if (record !== null && typeof record === 'object' && typeof record.taskId === 'string' && typeof record.sessionId === 'string') {
                nextStarted[record.taskId] = {
                  taskId: record.taskId,
                  sessionId: record.sessionId,
                  title: typeof record.title === 'string' ? record.title : '',
                  branch: typeof record.branch === 'string' ? record.branch : '',
                  worktreePath: typeof record.worktreePath === 'string' ? record.worktreePath : '',
                  startedAt: typeof record.startedAt === 'number' ? record.startedAt : Date.now(),
                }
              }
            }
            nextState = {
              ...nextState,
              turns: {
                ...nextState.turns,
                [turnStr]: {
                  ...prevTurnEntry,
                  started: nextStarted,
                },
              },
            }
            if (sessionId !== '') statesBySession.set(sessionId, nextState)
            return nextState
          }
        }

        if (nextState !== state && sessionId !== '') {
          statesBySession.set(sessionId, nextState)
        }
        return nextState
      },

      wire: {
        viewSchema: JSON_SCHEMA,
        view(state) {
          return {
            parentSessionId: state.parentSessionId,
            inheritedEventCount: state.inheritedEventCount,
            childOf: state.childOf,
            turns: state.turns,
            lastFailure: state.lastFailure,
          }
        },
      },
    })
  })

  // Listen for `agent/turn-stopping` on root and on each created agent's context
  // (matching `forecast` and `recap` so scoped emissions are always caught).
  if (typeof ctx.on === 'function') {
    ctx.on('agent/turn-stopping', (event) => handleTurnStopping(ctx, event))
  }

  ctx.inject(['llm'], (scoped) => {
    if (typeof scoped.on === 'function') {
      scoped.on('agent/turn-stopping', (event) => handleTurnStopping(scoped, event))
      scoped.on('agent/created', ({ agent }) => {
        agent?.ctx?.on?.('agent/turn-stopping', (event) => handleTurnStopping(scoped, event))
      })
    }
    const agents = scoped.get?.('agents')
    if (agents !== undefined && typeof agents.values === 'function') {
      for (const agent of agents.values()) {
        agent?.ctx?.on?.('agent/turn-stopping', (event) => handleTurnStopping(scoped, event))
      }
    }
  })

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      id: '@local/dsh-suggested-task:tasks',
      name: COMMAND_NAME,
      description: 'Generate follow-up task suggestions or launch them into isolated Git worktree child sessions',
      input: {
        hint: '[generate | start <turn> <taskId> | start-all [turn]]',
      },
      handler: (invocation) => handleTasksCommand(scoped, invocation),
    })
  })
}

export default { apply }
