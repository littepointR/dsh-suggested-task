# Suggested Task for DSH

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的常驻插件：每轮对话结束后，在对话流末尾给出几个可执行的后续任务建议（类似 Claude Desktop 的 Suggested Tasks），支持**单个点击开始**或**一键开始全部**，每个任务会自动 Fork 当前对话上下文、在独立的 Git 工作树（`.agents/worktrees/<branch>`）中作为独立子会话并行完成。

<img src="icon.svg" width="72" height="72" alt="后续任务建议图标">

[English](README.md) | 中文

## 功能

- **轮次末尾后续任务卡片（`conversation.chat.turnTail`）**：
  - 每轮对话正常结束后，自动基于当前对话上下文生成 2～3 个具体的后续任务建议（标题、简短说明、执行提示词与目标 Git 分支名）。
  - 支持点击单个任务的 **「开始」**，或点击卡片右上角的 **「全部开始 (N)」** 一键并行启动所有未开始的任务。
  - 任务启动后，卡片实时展示对应子会话的运行状态（`进行中` / `已就绪`）以及一键跳转按钮 **「查看子会话 →」**。
- **独立 Git 工作树隔离（`.agents/worktrees/...`）**：
  - 每个启动的任务都会先在当前完成轮次的边界处 **Fork 父会话**（完整继承当前对话的上下文），然后自动在仓库的 `.agents/worktrees/<branch>` 下创建独立 Git 工作树与分支，并将子会话的工作目录切换到该工作树中执行，互不干扰。
- **Claude 风格子会话展示与导航**：
  - **左侧会话栏自动缩进与父子关联**：新建的任务子会话会自动排列在父会话正下方，带有缩进导引线、子会话分支图标（`sidebar.session.row.leading`）以及悬浮详情卡片（`sidebar.session.row.hover`，显示所属父会话与工作树分支）。
  - **会话顶部父子面包屑与切换器（`conversation.session.header.actions`）**：
    - 在子会话中查看时，顶部标题旁显示可点击的 **`↖ 父会话：<标题>`** 胶囊与 **`⎇ <branch>`** 工作树分支标签，一键返回父会话。
    - 在父会话中查看时，顶部标题旁显示 **`↳ N 个子会话`** 状态下拉菜单，随时查看各子会话进度并切换过去。
- **`/tasks` 命令**：
  - `/tasks` 或 `/tasks generate [turn]`：按需为最近一轮（或指定轮次）生成/重新生成后续任务建议。
  - `/tasks start <turn> <taskId>`：启动指定轮次的单个建议任务。
  - `/tasks start-all [turn]`：一键启动指定轮次的全部未开始建议任务。

## 环境要求

- **DSH `>=0.2.1-rc.2`** —— `package.json` 通过 `engines.dsh` 声明了运行时下限。

## 安装

### 从 GitHub 安装（无需构建）

```bash
dsh plugin --profile web add github:littepointR/dsh-suggested-task
dsh web
```

`dsh plugin add` 会把安装转发给所选 profile 内的 pnpm；由于插件通过 `dsh.bundle.patch` 声明了 bundle，安装完成后会自动把该 bundle 加入 `dsh.profile.bundles`。插件是纯 JavaScript 实现、没有 `prepare` 构建脚本，因此从 Git 安装无需额外的 pnpm 构建授权。若 profile 未启用 HMR，重启 profile 后插件生效。

需要固定发布版本时：

```bash
dsh plugin --profile web add github:littepointR/dsh-suggested-task#v1.0.0
```

桌面应用的 `desktop` profile 由 Electron 应用独占管理，独立安装的 `dsh` CLI 会拒绝 `--profile desktop`。桌面版请在 **设置 → 插件 → 添加** 中粘贴仓库地址 `https://github.com/littepointR/dsh-suggested-task`，插件会即时生效，无需重启应用。

### 从本地检出安装

```bash
git clone https://github.com/littepointR/dsh-suggested-task.git
dsh plugin --profile <profile> add link:<本地检出目录的绝对路径>
```

bundle 的 `cordis.patch.yml` 会插入一行配置：

```yaml
- insert:
    - id: suggested-task
      name: '@local/dsh-suggested-task'
```

## 配置

所有字段均可选，可在 profile 的 `cordis.patch.yml` 中按 `suggested-task` 行覆盖：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不注册投影、轮次监听与 `/tasks` 命令 |
| `mode` | `'fork'` | `'fork'` 复用完整对话前缀；`'digest'` 发送紧凑 JSON 摘要 |
| `maxTasks` | `3` | 每轮最多给出的后续任务数量（`1..5`） |
| `maxTokens` | `1024` | 建议任务请求的输出 token 上限 |
| `temperature` | `0.3` | 采样温度 |
| `timeoutMs` | `15000` | 单次建议生成请求的超时时间（毫秒） |
| `maxForkChars` | `12000` | `fork` 模式保留的对话窗口字符上限 |
| `maxInputChars` | `6000` | `digest` 模式摘要字符上限 |
| `fallback` | `true` | `fork` 模式无结果时是否自动回退到 `digest` 模式 |
| `skipSubagents` | `true` | 子代理会话不自动生成建议任务 |
| `skipTaskSessions` | `true` | 由建议任务派生出的子会话默认不再自动生成下一层建议任务 |
| `worktreePrefix` | `'task/'` | Git 工作树分支名前缀（如 `task/add-unit-tests`） |
| `worktreeFallback` | `true` | 当前目录不是 Git 仓库时，允许回退为在原工作目录中启动子会话 |
| `provider`、`model` | 未设置 | 显式指定模型路由；默认复用本轮自己的模型路由 |

## 开发与测试

```bash
npm test        # 运行 Host 与 Client 单元测试
npm run check   # 语法检查
```

## 许可

MIT，详见 [LICENSE](LICENSE)。
