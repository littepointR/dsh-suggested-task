# Suggested Task for DSH

A resident plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that suggests actionable follow-up tasks at the end of each completed turn—just like Claude Desktop's Suggested Tasks—and lets you start any single task or **Start All** at once in isolated Git worktrees (`.agents/worktrees/<branch>`) as independent child sessions.

<img src="icon.svg" width="72" height="72" alt="Suggested Tasks icon">

English | [中文](README.zh.md)

## Features

- **Turn-end Suggested Tasks Card (`conversation.chat.turnTail`)**:
  - After each completed turn, proposes 2–3 concrete follow-up tasks with a title, concise description, execution prompt, and target Git branch slug.
  - Click **Start** on an individual task or **Start all (N)** in the card header to launch all unstarted tasks in parallel.
  - Once started, each row displays live child-session status (`Running` / `Ready`) and an **Open sub-session →** button.
- **Isolated Git Worktrees (`.agents/worktrees/...`)**:
  - Starting a task forks the parent session at that completed turn's event boundary (inheriting the conversation context), creates a dedicated Git worktree and branch under `.agents/worktrees/<branch>`, switches the child session's working directory into that worktree, and dispatches the task prompt automatically.
- **Claude-style Sub-session Lineage & Sidebar Visuals**:
  - **Left Sidebar Grouping & Indentation**: Child sessions are positioned directly beneath their parent session in the Workspace list, indented with a tree connector line, a sub-session branch icon (`sidebar.session.row.leading`), and a hover card (`sidebar.session.row.hover`) showing parent session and worktree branch details.
  - **Conversation Header Lineage (`conversation.session.header.actions`)**:
    - On a child session: displays a clickable **`↖ Parent: <Title>`** pill to jump back to the parent session and a **`⎇ <branch>`** worktree chip.
    - On a parent session: displays a **`↳ N sub-sessions`** dropdown switcher with live running counts.
- **`/tasks` Slash Command**:
  - `/tasks` or `/tasks generate [turn]`: Generate or regenerate suggested tasks on demand.
  - `/tasks start <turn> <taskId>`: Start a single suggested task in an isolated worktree child session.
  - `/tasks start-all [turn]`: Start all unstarted tasks of a turn in parallel worktree child sessions.

## Requirements

- **DSH `>=0.2.1-rc.2`** (declared in `package.json` `engines.dsh`).

## Installation

### From GitHub (no build step)

```bash
dsh plugin --profile web add github:littepointR/dsh-suggested-task
dsh web
```

`dsh plugin add` forwards to pnpm inside the chosen profile, installs the package, and adds the bundle to `dsh.profile.bundles` automatically because the package declares `dsh.bundle.patch`. The plugin is plain JavaScript with no `prepare` build script, so a Git install needs no extra pnpm build approval. Restart the profile for the plugin to load when HMR is disabled.

To pin the tagged release:

```bash
dsh plugin --profile web add github:littepointR/dsh-suggested-task#v1.0.0
```

The Desktop application's `desktop` profile is reserved for the Electron app, so a standalone `dsh` CLI rejects `--profile desktop`. Install there through **Settings → Plugins → Add** and paste the repository URL `https://github.com/littepointR/dsh-suggested-task`; the plugin applies without restarting the application.

### From a local checkout

```bash
git clone https://github.com/littepointR/dsh-suggested-task.git
dsh plugin --profile <profile> add link:<absolute-path-to-checkout>
```

The bundle patch inserts the `suggested-task` row, so the plugin survives restarts as a normal profile bundle.

## Configuration

Every field below is optional and can be overridden on the `suggested-task` row in the profile's `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` skips the projection, turn listener, and `/tasks` command |
| `mode` | `'fork'` | `'fork'` reuses the full conversation prefix; `'digest'` sends a compact JSON summary |
| `maxTasks` | `3` | Maximum suggested tasks per turn (`1..5`) |
| `maxTokens` | `1024` | Output budget of the suggestion request |
| `temperature` | `0.3` | Sampling temperature |
| `timeoutMs` | `15000` | Hard bound on one suggestion request, in milliseconds |
| `maxForkChars` | `12000` | Conversation-window budget in `fork` mode |
| `maxInputChars` | `6000` | Excerpt bound in `digest` mode |
| `fallback` | `true` | Retry with the compact digest when `fork` mode yields no tasks |
| `skipSubagents` | `true` | Subagent sessions get no task suggestions |
| `skipTaskSessions` | `true` | Child sessions started from suggested tasks do not auto-suggest further tasks |
| `worktreePrefix` | `'task/'` | Branch prefix for created Git worktrees (`task/add-unit-tests`) |
| `worktreeFallback` | `true` | Start in the current directory when the session is not in a Git repository |
| `provider`, `model` | unset | Explicit model route; defaults to the turn's own route |

## Development

```bash
npm test        # Run Host and Client unit tests
npm run check   # Syntax check all entrypoints and tests
```

## License

MIT, see [LICENSE](LICENSE).
