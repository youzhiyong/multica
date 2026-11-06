# 工作流编排（Workflow Orchestration）设计方案

> **状态：v0.1 草案，明确不完整。** 本文只用于第一轮方案讨论，不包含实现，也不代表已批准的范围。所有表结构、API、字段名均为示意，评审后可能调整。
>
> 关联：youzhiyong/multica#1 —「新增 工作流编排 功能，先给一版设计方案」
>
> 日期：2026-11-06

---

## 1. 摘要

Multica 目前的基本单位是「一个 issue 交给一个 agent 做完」。工作流编排要把它升级为「一个 issue 按可复用的阶段（stage）流转」：每个阶段由指定的 agent 或人执行，阶段之间自动交接，可以插入人工审批门，整个过程在 issue 详情里可见、可暂停、可取消。

本版方案的核心建议：

1. **第一版只做单 issue 的线性流程**，不做通用 DAG、不做跨 issue 编排、不做可视化画布。
2. **复用现有的 `agent_task_queue` 和 `TaskService`**，不引入新的任务执行基础设施；工作流只负责「下一步派给谁、什么时候派」。
3. **run 启动时快照流程定义**，模板后续修改不影响正在运行的实例。
4. **人工审批是一等阶段**，通过 inbox 通知 + issue 内操作完成，而不是靠评论约定。
5. **与现有触发器的交互必须先定清楚**（见 D4 与 7.7），这是本方案风险最高的部分。

本版**没有**回答的问题集中在第 17 节，需要产品决策后才能进入实现。

---

## 2. 现状：Multica 现在如何把任务交给 agent

### 2.1 触发路径（全部是硬编码）

当前没有「触发器配置」这一层，三个入口直接写在 handler 里：

| 触发场景 | 代码位置 | 行为 |
|---|---|---|
| issue 被分配给 agent（创建时或改派时） | `server/internal/handler/issue.go:1129` → `shouldEnqueueAgentTask` | 只校验 assignee 是未归档、有 runtime 的 agent，不校验 issue 状态，直接入队 |
| 成员在 issue 下评论 | `server/internal/handler/comment.go:263`（调用 `issue.go:1136` 的 `shouldEnqueueOnComment`） | 非终态（done/cancelled）且没有 pending 任务时，给 assignee agent 入队 |
| 评论里 @mention 某个 agent | `server/internal/handler/comment.go:369` 起 | 为被 mention 的 agent 入队；跳过自己、无 runtime、已归档、无权限的私有 agent |

`server/migrations/032_drop_agent_triggers.up.sql` 的注释写得很清楚：`on_assign / on_comment / on_mention` 现在**始终开启，不可配置**。

### 2.2 执行路径

1. handler 调用 `TaskService.EnqueueTaskForIssue` / `EnqueueTaskForMention`（`server/internal/service/task.go:36`、`:80`）创建 `agent_task_queue` 记录。
2. daemon 通过 `POST /api/daemon/runtimes/{runtimeId}/tasks/claim` 领取任务（`server/internal/handler/daemon.go:341`）。领取响应包含 agent 的 instructions、skills、工作区仓库、以及同一 (agent, issue) 的 prior session（用于续接会话）。
3. daemon 用 `BuildPrompt` 生成极短的 prompt（`server/internal/daemon/prompt.go:11`）：只告诉 agent issue ID，让它自己执行 `multica issue get <id> --output json` 拉取详情。
4. 任务完成/失败通过 `CompleteTask` / `FailTask` 落库；**服务端不修改 issue 状态**，状态由 agent 通过 CLI 自己改（`server/internal/service/task.go:232`、`:244`、`:324`）。
5. 任务队列对同一个 (issue, agent) 做串行化，不同 agent 可以并行处理同一个 issue（`server/pkg/db/queries/agent.sql` 的 `ClaimAgentTask`）。

### 2.3 当前能力边界

1. **单主线**：一个 issue 只有一个 assignee。多 agent 接力只能靠人改派或 @mention，无法表达「先实现、再评审、再验收」。
2. **触发不可配置**：无法按项目、标签、issue 类型定义不同的入口。
3. **没有阶段概念**：任务完成不会驱动任何后续动作；服务端不知道「这件事做到哪一步了」。
4. **没有等待人的状态**：inbox 有通知，但没有「流程停在某个审批节点、等待某人动作」的持久对象。
5. **没有失败策略**：任务失败即结束，没有重试、超时升级、回退。
6. **交接上下文弱**：任务 prompt 只含 issue ID，跨 agent 没有结构化的交付物契约。
7. **可观测性只有 task 维度**：没有 run/stage 维度的进度、耗时、失败原因聚合。

---

## 3. 目标与非目标

### 3.1 第一版目标

- workspace 内可以创建、编辑、启用/停用**可复用的线性流程模板**。
- 在某个 issue 上启动一次 run，引擎按阶段自动派发：agent 阶段创建 agent 任务，member 阶段指派成员，approval 阶段等待审批。
- agent 任务完成/失败能驱动阶段推进；失败可重试或暂停。
- issue 详情能看到当前阶段、阶段历史、当前执行者，并能暂停/恢复/取消/审批。
- 所有动作进入现有 activity/timeline 和 inbox 通知体系。
- 完全遵守现有 workspace 多租户、权限和 agent 可见性规则。

第一版的验收场景（用于判断方案是否落地成功）：

> 在 issue 上启动「实现（agent A）→ 人工验收（approval）」两步流程，或「实现（agent A）→ 同 agent 复核 → 人工验收」三步流程，无需人工改派即可走完；中途可以暂停、取消；任一步失败在 issue 内可见，并能重试。跨 agent 的代码交接见 8.3，属于后续阶段。

### 3.2 非目标（本方案明确不做）

- 通用自动化规则引擎（if-this-then-that、任意 trigger/action 组合）。
- 任意 DAG、并行分支、条件分支的可视化画布。
- 跨 issue 的编排（例如父 issue 自动展开子 issue 并汇总结果）。
- 外部系统集成、webhook、cron 定时触发。
- 跨 workspace 的模板共享或模板市场。
- 修改现有「分配/评论/mention」默认行为（除 D4 明确要求的部分）。
- 计费、配额、按工作流结算。

---

## 4. 核心模型

### 4.1 概念

| 概念 | 说明 | 与现有实体的关系 |
|---|---|---|
| **Workflow（流程模板）** | workspace 级的可复用定义，包含有序阶段列表 | 新表 `workflow` |
| **Stage（阶段）** | 定义中的一步：执行者、指令、失败策略 | 存在 `workflow.definition` JSONB 中 |
| **Run（运行实例）** | 模板在某个 issue 上的一次执行 | 绑定一个 issue；启动时快照 definition |
| **Stage Run（阶段执行）** | 一次阶段执行，包含尝试次数、关联任务、结果 | 新表 `workflow_stage_run` |
| **Gate（审批门）** | 一种阶段类型：等待指定的人 approve/reject | 阶段类型 `approval` |
| **Trigger（启动方式）** | 手动启动；后续可扩展自动启动 | 第一版只做手动 |

### 4.2 阶段类型

第一版只有三种，够覆盖「agent 干活 → 人复核」的主场景：

| 类型 | 执行者 | 引擎行为 | 完成信号 |
|---|---|---|---|
| `agent` | 指定 agent | 创建 `agent_task_queue` 任务，并把 issue assignee 指向该 agent（见 D6） | 关联任务 `completed` |
| `member` | 指定 workspace 成员 | 指派 issue 给该成员，创建 inbox 通知 | 成员在 issue 里点「完成此阶段」 |
| `approval` | 指定成员 / workspace 管理员 | 不派发任务，创建 inbox 审批通知，阶段进入 `waiting_approval` | 审批人点「通过 / 驳回」 |

### 4.3 状态机

```
workflow_run
  pending ──▶ running ──▶ completed
                │  ▲
                │  └──── paused（人工暂停 / 失败后暂停 / 等待决策）
                ├──────▶ failed
                └──────▶ cancelled
```

```
workflow_stage_run
  pending ──▶ running ──▶ completed ──▶ (下一阶段)
                │              │
                │              └── 最后一个阶段完成 → run completed
                ├──▶ waiting_approval ──▶ completed / failed
                ├──▶ failed ──▶ 按失败策略：retry（attempt + 1）| pause run | fail run
                └──▶ cancelled
```

约束：

- 同一时刻一个 run 只有一个 `running`/`waiting_approval` 阶段。
- 同一时刻一个 issue 最多一个活跃 run（`pending/running/paused`）。由部分唯一索引保证。
- 阶段定义是**线性有序数组**，第一版没有回边（不能从评审回到实现）。驳回行为见 9.3，第一版建议驳回 = run `failed`，修正后重新启动一个 run。

### 4.4 与现有实体的关系

```
workspace
 └─ workflow（模板，definition JSONB）
      └─ workflow_run（快照，绑定 1 个 issue）
           ├─ workflow_stage_run #1 ── agent_task_queue（agent 阶段）
           ├─ workflow_stage_run #2 ── agent_task_queue（agent 阶段）
           └─ workflow_stage_run #3 ── inbox_item（approval 阶段）

issue ──1:N── workflow_run（历史 run 保留；同一时刻最多 1 个活跃 run）
agent_task_queue.workflow_stage_run_id ──▶ workflow_stage_run.id（可空，普通任务为 NULL）
activity_log：复用现有表，新增 action 字符串（workflow_started / stage_changed / workflow_completed / ...）
inbox_item：复用现有表，新增 type（workflow_approval_requested / workflow_run_failed / ...）
```

---

## 5. 关键设计决策

| # | 决策 | 建议 | 备选 | 理由 / 代价 |
|---|---|---|---|---|
| D1 | 编排对象 | 单 issue 线性流程 | 跨 issue DAG / 通用规则引擎 | 复用 issue 详情、任务队列、评论和权限体系；DAG 和跨 issue 需要新的「容器」概念，第一版性价比低 |
| D2 | 谁推进阶段 | agent 阶段由任务完成自动推进；member/approval 阶段由人操作推进；agent 不能直接改 run 状态 | 全部人工推进 / agent 用 CLI 显式推进 | 自动推进才有价值；显式 verdict 需要新的 CLI + 协议，放到后续 |
| D3 | 阶段完成信号 | 第一版 = 关联任务 `completed` | 解析 agent 输出 / 评论指令 / 显式 verdict | 最简单且可靠；缺点是「任务跑完」不等于「结果合格」，用 approval 阶段兜底 |
| D4 | 与现有触发器的关系 | run 活跃期间，工作流接管该 issue 的 agent 派发；仅暂停 `on_assign` 自动入队，评论/mention 触发保留 | 完全不改触发器，工作流额外派发 | 不改会重复建任务（工作流改 assignee 会触发 `on_assign`）；该决策影响现有行为，需要确认 |
| D5 | 版本化 | run 启动时把 definition 快照进 `workflow_run.definition_snapshot`，不做独立 version 表 | 模板版本表 + 发布流程 | 编辑中的模板不影响运行中的实例；代价是无法「统一升级」旧 run |
| D6 | 运行期间的 assignee | 跟随当前阶段执行者（agent 或 member） | 保持用户原本的 assignee | assignee 是最直观的「现在谁在做」；代价是可能与用户手动改派冲突，见 7.7 |
| D7 | 阶段交付物 | 第一版用 task result（`output`）+ issue 评论；跨 agent 代码交接单独处理 | 结构化 artifact 表 + 文件/分支协议 | 结构化交付物需要定义 schema 和 UI；先把主链路跑通 |

### 5.1 关于 D4 的补充

这是本方案最需要先确认的技术决策。当前「改派给 agent」会入队（`issue.go:1081-1088`），「分配变更」还会先 `CancelTasksForIssue`。如果工作流在派发阶段时直接改 assignee，就会：

1. 触发一次重复任务；
2. 或者在下一步改派时把当前阶段的任务取消掉。

可选方案：

- **A（建议）**：工作流派发通过 service 直接更新 issue（不经过 handler 的触发逻辑）；同时给 `shouldEnqueueAgentTask` 增加「该 issue 有活跃 run 则跳过」的判断。行为变化仅限已启动工作流的 issue；评论/mention 触发不受影响。
- **B**：不修改 assignee，只在 UI 上显示阶段执行者。改动最小，但「issue 当前由谁负责」会变得不直观。
- **C**：给任务增加 origin 字段，触发逻辑只跳过 `origin=workflow` 的任务。更精细，但需要改任务表和查询。

第一版建议 A；如果产品希望「assignee 始终由人控制」，则选 B。

### 5.2 关于阶段指令

阶段需要告诉 agent「这一步做什么」。两种承载方式：

- **存进任务上下文**（推荐）：`agent_task_queue.context` 已存在（`003_task_context.up.sql`），但当前 daemon 不使用它。扩展 claim 响应，把阶段信息传给 daemon，由 `BuildPrompt` 注入。
- **写进 issue 评论/描述**：不需要改 daemon，但会污染用户内容、难以区分系统指令，且 agent 可能忽略。不推荐作为主方案。

---

## 6. 数据模型（示意）

> 以下 SQL 是设计示意，不是最终迁移文件。字段名、约束、索引都需要在实现阶段复核。

### 6.1 表结构

```sql
-- 流程模板
CREATE TABLE workflow (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    -- {"stages":[{key,name,kind,actor_type,actor_id,instructions,on_failure,timeout_seconds,on_complete}]}
    definition JSONB NOT NULL DEFAULT '{"stages":[]}',
    enabled BOOLEAN NOT NULL DEFAULT true,
    deleted_at TIMESTAMPTZ,
    created_by_type TEXT NOT NULL CHECK (created_by_type IN ('member','system')),
    created_by_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_workflow_workspace ON workflow(workspace_id) WHERE deleted_at IS NULL;

-- 运行实例
CREATE TABLE workflow_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    workflow_id UUID NOT NULL REFERENCES workflow(id) ON DELETE RESTRICT,
    issue_id UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','paused','completed','failed','cancelled')),
    current_stage_key TEXT,
    definition_snapshot JSONB NOT NULL,
    started_by_type TEXT NOT NULL CHECK (started_by_type IN ('member','system')),
    started_by_id UUID,
    error TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一 issue 最多一个活跃 run
CREATE UNIQUE INDEX uq_workflow_run_active_issue
    ON workflow_run(issue_id)
    WHERE status IN ('pending','running','paused');
CREATE INDEX idx_workflow_run_issue ON workflow_run(issue_id, created_at DESC);

-- 阶段执行
CREATE TABLE workflow_stage_run (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    stage_key TEXT NOT NULL,
    stage_index INT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('agent','member','approval')),
    actor_type TEXT CHECK (actor_type IN ('member','agent')),
    actor_id UUID,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','waiting_approval','completed','failed','skipped','cancelled')),
    attempt INT NOT NULL DEFAULT 1,
    instructions TEXT,
    result JSONB,
    error TEXT,
    next_attempt_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, stage_key, attempt)
);
CREATE INDEX idx_stage_run_run ON workflow_stage_run(run_id, stage_index);
-- 同一个 run 同时只能有一个执行中的阶段
CREATE UNIQUE INDEX uq_stage_run_active_per_run
    ON workflow_stage_run(run_id)
    WHERE status IN ('running','waiting_approval');

-- 任务关联（只在一个方向存，避免双写）
ALTER TABLE agent_task_queue
    ADD COLUMN workflow_stage_run_id UUID REFERENCES workflow_stage_run(id) ON DELETE SET NULL;
CREATE INDEX idx_agent_task_queue_workflow_stage
    ON agent_task_queue(workflow_stage_run_id)
    WHERE workflow_stage_run_id IS NOT NULL;
```

### 6.2 为什么定义存 JSONB

- 模板编辑是整体保存，阶段不需要被其他表外键引用。
- 定义天然需要随版本演进；run 只需要快照。
- 校验放在 API 层（阶段数量上限、key 唯一、kind 合法、actor 必须存在且有权限、不能有环——线性数组天然无环）。

代价：无法用 SQL 查询「哪些模板含某个 agent 的阶段」。第一版不需要；如果后续需要，可以在 run 维度建索引或额外落一张 `workflow_stage` 投影表。

### 6.3 幂等与并发

- `uq_workflow_run_active_issue` 防止同一 issue 重复启动。
- `UNIQUE (run_id, stage_key, attempt)` 防止同一阶段重复推进。
- `uq_stage_run_active_per_run` 防止一个 run 同时出现两个执行中的阶段。
- 所有状态迁移用条件更新：`UPDATE workflow_stage_run SET status='completed' WHERE id=$1 AND status='running'`，受影响行数为 0 说明已被其他路径处理。
- 对账/推进任务用 `SELECT ... FOR UPDATE SKIP LOCKED`，避免多实例重复处理（当前是单实例部署，但数据库层约束应提前做好）。

### 6.4 现有唯一索引带来的约束

`agent_task_queue` 上有 `idx_one_pending_task_per_issue_agent`（`037_fix_pending_task_unique_index.up.sql`）：同一 (issue, agent) 只能有一个 queued/dispatched 任务。工作流重试时如果该 agent 已有一个排队的评论任务，直接入队会冲突。处理方式：

- 派发失败（唯一约束冲突）时，阶段保持 `pending`，设置 `next_attempt_at`，交给 reconciler 稍后重试；
- 或者复用已有的 pending 任务（需要任务能表达「这次执行同时属于某阶段」，实现更复杂）。

第一版建议前者，并在日志中记录冲突原因。

---

## 7. 执行引擎

### 7.1 代码落点（建议）

```
server/internal/workflow/          # 纯领域逻辑：定义校验、状态机、下一阶段计算（无 DB 依赖，易测试）
server/internal/service/workflow.go # WorkflowService：事务、调用 TaskService、写 activity、发事件
server/cmd/server/workflow_listeners.go    # 订阅 task:completed / task:failed / issue 事件
server/cmd/server/workflow_reconciler.go   # 定时对账，修复丢失的推进
server/cmd/server/router.go        # 新增路由
```

复用现有结构：`TaskService` 在 `server/cmd/server/main.go` 里创建，workflow service 持有 `*db.Queries`、`*TaskService`、`*events.Bus`。

### 7.2 启动 run

1. API 校验：workflow 属于当前 workspace、enabled、定义合法、issue 无活跃 run、调用者有权限、阶段里的 agent 对调用者可见且可分配。
2. 事务内插入 `workflow_run`（快照 definition）和第一个 `workflow_stage_run`。
3. 事务提交后派发第一阶段（见 7.3），发布 `workflow:run_updated`。
4. 记录 activity `workflow_started`。

失败处理：派发失败不回滚 run，run 进入 `paused` 并带 `error`，由人处理；这样不会出现「run 存在但无法看到的中间态」。

### 7.3 派发阶段

**agent 阶段**：

1. 校验 agent 未归档、有 runtime。
2. 调用新增的 `TaskService.EnqueueTaskForAgent(ctx, issue, agentID, workflowStageRunID, priority)`：
   - 与 `EnqueueTaskForMention` 类似，但显式接收 agent 和阶段 ID；
   - 创建任务时写入 `workflow_stage_run_id`；
   - 现有 `CreateAgentTask` 需要增加可空参数（sqlc 重新生成）。
3. 按 D6 更新 issue assignee 为该 agent（建议走直接 update，不触发 handler 的入队逻辑）。
4. 阶段置 `running`，记录 `started_at`。
5. 发布 WS 事件，activity 记录 `workflow_stage_started`。

**member 阶段**：

1. 更新 issue assignee 为该成员（不会触发 agent 自动任务）。
2. 阶段置 `running`。
3. 创建 inbox 通知（`workflow_stage_assigned`），链接到 issue 和阶段。

**approval 阶段**：

1. 阶段置 `waiting_approval`。
2. 按审批人配置创建 inbox 通知（`workflow_approval_requested`，severity=`action_required`）。
3. 等待 `POST /workflow-runs/{id}/stages/{stageRunId}/approve|reject`。

### 7.4 推进

推荐做法：`WorkflowService` 订阅 `task:completed` / `task:failed`（现有事件总线，进程内同步），并根据任务的 `workflow_stage_run_id` 判断是否需要推进。

- `task:completed`：
  - 条件更新阶段为 `completed`（仅当当前是 `running` 且 attempt 匹配）；
  - 保存 `result`（取自任务的 result）；
  - 计算下一阶段，事务内创建下一阶段的 `workflow_stage_run`（`pending`）；没有下一阶段则 run `completed`，按定义设置 issue 状态（建议默认 `done`，见第 17 节第 6 条）；状态变更必须走与 handler 相同的发布路径（`issue:updated` + activity + 订阅者通知），不能只写库，否则前端和通知不会更新；
  - 事务提交后派发下一阶段；派发失败时阶段保持 `pending`（设置 `next_attempt_at`），由 reconciler 重试；
  - 写 activity；发 WS。
- `task:failed`：
  - 按阶段 `on_failure` 策略处理：
    - `retry`：`attempt + 1`，新建一条 stage_run，设置 `next_attempt_at`（建议 30s 起，指数退避），由 reconciler 派发；
    - `pause`（默认）：run 置 `paused`，记录 error，inbox 通知发起人；
    - `fail`：run 置 `failed`。
- `task:cancelled`：等同失败，但 error 为「任务被取消」，默认 `pause`。

为什么走事件而不是在 `TaskService.CompleteTask` 里直接调用：保持 TaskService 只关心任务生命周期；事件订阅与 activity/notification 的现有模式一致（`server/cmd/server/activity_listeners.go`）。风险是事件总线是**进程内同步、best-effort**（`server/internal/events/bus.go`），进程崩溃会丢事件。因此必须有 7.6 的对账。

### 7.5 失败、重试、超时

- 每个阶段定义 `on_failure: {strategy: retry|pause|fail, max_attempts: 1..3}`，默认 `pause`。
- 阶段级超时：复用现有任务超时（`FailStaleTasks`）+ 阶段自身的 `timeout_seconds`，由 reconciler 检查「running 超过阈值且任务不活跃」。
- 重试保留历史 stage_run（attempt 递增），UI 展示尝试次数。
- agent 被归档/删除 runtime：派发失败 → 按 `pause` 处理，inbox 通知发起人。

### 7.6 对账（reconciler）

必须做，不建议只靠事件。每 30–60 秒扫描：

1. run 是 `running`，当前阶段是 `running`，但关联任务已 `completed/failed/cancelled` → 补推进。
2. 阶段是 `pending` 且 `next_attempt_at <= now()` → 补派发。
3. 阶段 `running` 但没有关联任务且超过 N 秒 → 标记失败/暂停。
4. run 是 `running`，当前阶段（`current_stage_key`）已 `completed`，但不存在后续阶段执行记录 → 补建/补派发；
5. run 是 `paused` 但 `error` 为空（异常状态）→ 记录并告警。

现有 `runRuntimeSweeper`（`server/cmd/server/runtime_sweeper.go`）是可参考的 ticker 模式。多实例部署时用 `FOR UPDATE SKIP LOCKED`。

### 7.7 与现有行为的交互矩阵

| 现有行为 | run 活跃时会发生什么 | 建议处理 |
|---|---|---|
| 人工把 issue 改派给另一个 agent | `issue.go:1081-1088` 会 `CancelTasksForIssue`，取消当前阶段任务；随后为新 assignee 入队（采用 D4-A 时不会入队） | 工作流监听 `task:cancelled`，把阶段标记失败并 `pause` run；避免自动重新派发造成「人已接管但工作流继续」 |
| 人工改派给成员 | 取消阶段任务（如果是 agent 阶段），新 assignee 无任务 | 同上；或检测到 assignee 变更时直接 `pause` run |
| 成员在 issue 评论 | 给 assignee（可能是当前阶段 agent）入队；若已有 pending 则合并 | 保留：这是人工追问，不应当被工作流吞掉；注意它会在阶段完成后多跑一次 |
| 成员 @mention 其他 agent | 给被 mention 的 agent 入队 | 保留；与工作流并行，可能产生额外评论 |
| 取消任务 | 阶段关联任务被取消 | 阶段失败 → 默认 `pause`，通知发起人 |
| 归档 agent / 删除 runtime | 后续派发失败 | `pause` run + inbox 通知 |
| 删除 issue | FK CASCADE 删除 run；任务已由现有逻辑取消 | 无需额外处理 |
| 任务超时（`FailStaleTasks`） | 任务 failed | 走失败策略 |
| 现有 `task:failed` 通知 | 会同时给订阅者发通知 | 按任务的 `workflow_stage_run_id` 判断，抑制或合并工作流阶段的失败通知，避免一次失败两条通知 |

这个矩阵说明：**工作流不能假设自己独占 issue**。第一版应该把「run 期间的人为干预」当作一等场景，默认暂停而不是自动纠正。

### 7.8 暂停与取消

- **暂停（soft）**：当前阶段继续执行，阶段完成后 run 进入 `paused`，不再派发下一阶段。适合「我想先看看结果」。
- **立即停止（hard）**：取消当前任务，阶段和 run 都置 `cancelled`。第一版用「取消 run」表达，不额外做「立即暂停」。
- **恢复**：从 `paused` 继续，重新派发当前阶段（若阶段未完成）或进入下一阶段。
- 取消不可恢复；只取消与本次 run 的阶段关联的任务（按 `workflow_stage_run_id`），不要用 issue 级别的 `CancelTasksForIssue`，避免误伤人工评论/mention 触发的任务。

---

## 8. Agent 协议与阶段上下文

### 8.1 阶段信息如何到达 agent

建议扩展 daemon 的 claim 响应（`AgentTaskResponse`，`server/internal/handler/agent.go:75`）增加可选字段：

```json
{
  "workflow": {
    "run_id": "...",
    "stage_run_id": "...",
    "workflow_name": "功能交付",
    "stage_key": "implement",
    "stage_name": "实现",
    "stage_index": 1,
    "stage_total": 3,
    "instructions": "实现 issue 描述中的功能，提交代码并评论说明改动。",
    "is_last_stage": false
  }
}
```

daemon 在 `BuildPrompt` 中追加一段简短说明（不把长指令塞进 prompt，仍让 agent 用 CLI 拉全量）：

```
Workflow stage: 实现 (1/3) — 功能交付
Stage instructions: <instructions>
Do not change the issue status; the workflow advances it after this task completes.
```

`multica issue get` 的 JSON 也建议带上当前 run/stage（后续阶段做），方便 agent 判断自己处于哪一步。

### 8.2 完成信号的限制

第一版「任务完成 = 阶段完成」有一个明显问题：agent 可能任务成功退出，但结果不合格（例如评审没发现问题）。本方案用 approval 阶段兜底，但更理想的是显式 verdict：

```
multica workflow complete-stage --task <task-id> --verdict pass|fail --note "..."
```

这会新增 daemon→server 的协议、CLI 命令和权限校验。第一版不做，列为后续增强；如果产品认为「评审 agent 必须给出 pass/fail」是核心，则必须提前到第一版（见第 17 节第 5 条）。

### 8.3 代码交付物与 worktree 限制（重要）

当前执行环境是 per (agent, issue) 的 worktree：

- daemon 复用同一 (agent, issue) 的 `work_dir`（`server/internal/daemon/daemon.go:927` 附近注释：不清理，供后续任务复用）。
- 不同 agent 各自准备独立的 worktree 和分支（`server/internal/daemon/execenv/git.go`）。
- `TaskResult` 已经预留了 `branch_name`（`server/internal/daemon/types.go:75`），daemon client 也会在非空时发送；但当前 `runTask` 没有填充它，`TaskCompleteRequest`（`server/internal/handler/daemon.go:514`）也没有接收该字段，所以分支信息实际上没有落库。

这意味着**实现 agent 的未提交改动，评审 agent 看不到**；即使是已提交的分支，当前也没有传递链路。因此：

- 如果阶段 1 是实现、阶段 2 是另一个 agent 评审，评审 agent 需要能 checkout 实现分支，或者实现 agent 必须 push 分支。
- 第一版可选策略：
  - **A**：同一 agent 跑多个阶段（复用 workdir 和 session），跨 agent 只做 member/approval 阶段；
  - **B**：要求 agent 阶段提交并推送分支，补齐「daemon 上报 branch_name → server 存储 → 下一阶段 claim 响应带 `base_ref` → daemon 检出」这条链路；
  - **C**：阶段共享 workdir（不推荐，破坏 per-agent 会话隔离和并发）。

建议第一版选 A（先把流程跑通），B 作为第二阶段；如果产品明确要求「实现 agent + 评审 agent」跨 agent 协作，则 B 必须提前，属于 daemon/execenv 的改动，范围会扩大。这是第 17 节第 4 条。

---

## 9. 人工审批与通知

### 9.1 审批人配置

第一版建议支持三种（按优先级实现）：

1. 指定成员（`member_id`）；
2. workspace 管理员/所有者（所有 admin/owner 都可审批，任一人通过即可）；
3. issue 订阅者（新增或已有订阅者都可以）。

默认用「指定成员」；「管理员」适合没有固定审批人的小团队。

### 9.2 通知

复用 `inbox_item` 和现有 notification listener 模式（`server/cmd/server/notification_listeners.go`）：

| type | severity | 触发 | 接收者 |
|---|---|---|---|
| `workflow_approval_requested` | `action_required` | 进入 approval 阶段 | 审批人 |
| `workflow_stage_assigned` | `attention` | 进入 member 阶段 | 该成员 |
| `workflow_run_paused` | `attention` | 失败/人工干预导致暂停 | run 发起人 |
| `workflow_run_failed` | `attention` | run 失败 | run 发起人 |
| `workflow_run_completed` | `info` | run 完成 | run 发起人 |

第一版建议：只通知发起人和审批人，避免订阅者被流程噪音淹没；完成通知可以复用现有 issue 状态变更通知。

### 9.3 审批结果

- **通过**：阶段 `completed`，进入下一阶段。
- **驳回**：第一版建议 run `failed` + 记录驳回原因（评论/activity）。不自动回退到某个阶段：回退会引入环和「最多回退几次」的策略，第一版不值得；用户修正后可以重新启动一个 run（历史 run 保留）。
- 后续可支持 `on_reject: {goto: stage_key, max_loops: 2}`，但需要环检测和 UI 表达。

---

## 10. API 设计（示意）

所有接口都在现有 workspace 中间件下，路径沿用 `/api/...` 风格。

### 10.1 模板管理

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/workflows` | 成员 | 列表（含 enabled、阶段数） |
| `POST` | `/api/workflows` | owner/admin | 创建 |
| `GET` | `/api/workflows/{id}` | 成员 | 详情 |
| `PUT` | `/api/workflows/{id}` | owner/admin | 整体更新 definition |
| `DELETE` | `/api/workflows/{id}` | owner/admin | 软删除（有活跃 run 时 409） |
| `POST` | `/api/workflows/{id}/duplicate` | owner/admin | 复制模板（可选） |

### 10.2 运行

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `POST` | `/api/issues/{id}/workflow-runs` | 成员 | body: `{workflow_id}`；已有活跃 run 返回 409 + 现有 run |
| `GET` | `/api/issues/{id}/workflow-runs` | 成员 | run 历史 |
| `GET` | `/api/workflow-runs/{runId}` | 成员 | run + 阶段列表 |
| `POST` | `/api/workflow-runs/{runId}/pause` | 发起人或 admin | 请求在阶段边界暂停 |
| `POST` | `/api/workflow-runs/{runId}/resume` | 发起人或 admin | 恢复 |
| `POST` | `/api/workflow-runs/{runId}/cancel` | 发起人或 admin | 取消并级联取消任务 |
| `POST` | `/api/workflow-runs/{runId}/stages/{stageRunId}/complete` | 当前 member 阶段执行者或 admin | member 阶段完成 |
| `POST` | `/api/workflow-runs/{runId}/stages/{stageRunId}/approve` | 审批人 | body: `{comment?}` |
| `POST` | `/api/workflow-runs/{runId}/stages/{stageRunId}/reject` | 审批人 | body: `{reason}` |

错误语义：

- `403`：workspace 角色不足、不是当前阶段执行者/审批人、私有 agent 不可用；
- `404`：跨 workspace 访问（不暴露存在性）；
- `409`：已有活跃 run、模板被运行中引用无法删除、任务派发冲突；
- `422`：definition 校验失败（阶段为空、key 重复、actor 不存在、超过 20 个阶段）。

### 10.3 事件

新增 WS 事件（`server/pkg/protocol/events.go`）：

- `workflow:run_updated`：`{run_id, issue_id, status, current_stage_key, current_stage_run_id}`
- `workflow:stage_updated`：`{run_id, stage_run_id, status, name, attempt}`

前端通过现有的 query invalidation 机制刷新（参考 `packages/core/realtime/` 的既有模式）。

### 10.4 CLI（后续）

第一版不要求 agent 用 CLI 操作工作流。后续可加：

```
multica workflow list
multica workflow status <issue-id>
multica workflow complete-stage --task <task-id> --verdict pass|fail
```

---

## 11. 前端与交互

### 11.1 导航

在左侧 Configure 分组新增 `Workflows`（`packages/views/layout/app-sidebar.tsx:82` 的 `configureNav`）。所有成员可见（只读），owner/admin 可编辑。

### 11.2 Workflows 页面

复用 Agents 页面的左右分栏模式（`packages/views/agents/components/agents-page.tsx`）：

- 左列：模板列表 + 新建按钮 + 启用状态。
- 右列：模板详情 = 名称/描述 + 阶段编辑列表。
- 阶段编辑用**有序列表 + 上移/下移**，不做画布；每行包含：类型、执行者（agent/member picker）、指令（多行输入）、失败策略、超时。
- 保存时前端校验 + 后端 422 错误展示。
- 空状态：无模板时展示「创建一个流程模板」+ 推荐模板（可选）。

### 11.3 Issue 详情

在右侧 Properties 侧栏（`packages/views/issues/components/issue-detail.tsx:1175` 附近）Project 之后增加 `Workflow` 区块：

- 无 run：`Start workflow` 按钮 + 模板选择器。
- 有 run：当前阶段名称、阶段序号/总数、执行者头像、状态 badge；操作按钮（暂停/恢复/取消/完成阶段/审批）。
- 阶段历史：点击展开侧面板或对话框，按时间列出每个阶段的尝试、结果、评论链接。
- 运行中的 issue 在列表/看板卡片上显示阶段 badge（可放到后续阶段）。

### 11.4 Inbox

新增通知类型的展示文案和跳转（点击打开 issue 并定位到 Workflow 区块）。审批通知提供「通过/驳回」快捷操作（可放到后续）。

### 11.5 设计约束

- 所有颜色/字号/间距遵守 `docs/design.md`，使用 shadcn 语义 token。
- 不引入新的视觉语言；阶段状态用现有 badge 形态。
- 第一版不提供线框图/wireframe，交互细节在实现前单独确认（本方案的明确缺口）。

---

## 12. 权限、安全与多租户

- 所有查询和写入都按 `workspace_id` 过滤，沿用 `RequireWorkspaceMember`。
- 模板管理：owner/admin；启动/暂停/取消：workspace 成员；审批：配置的审批人。
- agent 阶段必须校验 agent 属于当前 workspace、对发起人可见（私有 agent 仅 owner/admin 可使用），复用 `canAssignAgent` 的规则（`server/internal/handler/issue.go`）。
- 阶段指令是成员输入的文本，会进入 agent prompt，等同于 issue 描述的信任级别；不额外放大权限。需要在 UI 提示「指令会发送给 AI agent」。
- agent 通过 `X-Agent-ID` 调用 API 时，禁止创建/修改 workflow；只允许读取与自己任务相关的阶段信息（如果后续开放 verdict 接口，必须校验任务归属）。
- 审计：模板创建/修改、run 启动/暂停/取消/审批都写 `activity_log`，actor 使用真实操作者。
- 删除模板：有活跃 run 时拒绝；采用**软删除**（`deleted_at`），这样历史 run 的 `workflow_id` 仍然有效，run 也保留自己的 definition 快照，不受模板后续修改或删除影响。

---

## 13. 可观测性

- **activity_log**：新增 action：`workflow_started`、`workflow_stage_started`、`workflow_stage_completed`、`workflow_stage_failed`、`workflow_paused`、`workflow_resumed`、`workflow_cancelled`、`workflow_completed`。details 里带 run_id/stage_key/attempt。
- **日志**：`slog` 字段统一加 `run_id`、`stage_run_id`、`task_id`；派发失败、对账修复、状态冲突都记 warn。
- **UI**：issue 内的时间线已经支持 activity（`ListTimeline`），工作流事件直接进入时间线；不新增独立时间线。
- **用量**：任务用量仍按 agent/runtime 统计；可选在 run 详情里聚合展示（后续）。

---

## 14. 分阶段落地

| 阶段 | 内容 | 明确不做 | 验收 |
|---|---|---|---|
| **0. 本方案** | 评审、确认第 17 节问题 | 任何代码 | 方案获批 |
| **1. MVP** | 模板 CRUD（JSON definition）、线性 agent/member/approval 阶段、手动启动、任务完成推进、issue 面板、activity + inbox、取消 | 自动启动、重试/超时、跨 agent 代码交接、DAG | 验收场景可走通；单元 + 集成 + 1 条 e2e |
| **2. 稳定性** | 失败重试/超时、reconciler、暂停/恢复、通知完善、看板 badge | 分支、分支交接 | 人为中断、任务失败、进程重启后 run 不丢 |
| **3. 上下文** | claim 响应带阶段信息、daemon prompt 注入、CLI `issue get` 带 workflow、跨 agent 分支交接、自动启动规则 | DAG | 跨 agent 评审可跑通 |
| **4. 编排进阶** | 条件分支、并行、跨 issue、可视化 | — | 另立设计文档 |

阶段 1 的范围建议控制在一个 PR 系列内（schema + service + handler + 前端页面 + 测试），不要和阶段 2 的 reconciler 混在一起。

---

## 15. 测试策略

- **纯状态机**：`server/internal/workflow/*_test.go`，表驱动覆盖：启动、推进、失败策略、驳回、取消、非法定义校验。无 DB。
- **集成**：沿用 `server/internal/handler` 的测试 DB 模式（`testPool`）：
  - 启动 run 后任务被创建且带 `workflow_stage_run_id`；
  - 完成任务后下一阶段被派发；
  - 重复启动返回 409；
  - 两个并发推进只有一个成功（条件更新）；
  - 取消 run 会取消活跃任务。
- **前端**：`packages/views` 的 Vitest 测试阶段编辑器校验、issue 面板状态展示；`packages/core` 测 query/mutation key。
- **E2E**：Playwright 走「创建模板 → issue 启动 → 完成任务 → 审批 → run completed」。
- **迁移**：up/down 都能执行（CI 目前只跑 up，需要手动验证 down）。
- **不做**：性能压测、多实例并发压测（第一版单实例，留到阶段 2）。

---

## 16. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 与现有 assign/comment 触发器重复建任务 | agent 重复执行、评论重复 | D4 + 7.7 的交互矩阵；优先做「活跃 run 时不自动派发 assignee」 |
| 事件总线丢事件导致 run 卡住 | 流程停在某阶段无人察觉 | 7.6 reconciler；run 详情显示最后活动时间 |
| agent 自行改 issue 状态，和引擎冲突 | 状态来回跳、UI 误导 | run 期间 prompt 明确禁止改状态；引擎在阶段边界统一设置状态；发现人工/agent 改状态时暂停 |
| 跨 agent 代码交接不可用 | 「实现→评审」跨 agent 场景无法真正工作 | 8.3 的分阶段策略；第一版限制同 agent 或人工评审 |
| 流程模板过于复杂，用户不会用 | 功能上线但无人使用 | 第一版只做线性 + 内置示例模板；编辑用列表不用画布 |
| 审批通知打扰 | 用户关通知 | 只通知审批人/发起人；同类通知合并 |
| 重试与唯一索引冲突 | 阶段卡住 | 7.3/6.4 的延后重试 + reconciler |
| 模板编辑影响运行中的 run | 行为不一致 | definition 快照 |
| 循环/无限推进 | 资源浪费 | 线性无环；阶段数上限 20；重试次数上限 3；run 最大时长告警 |

---

## 17. 待确认问题（需要产品或维护者决策）

这些问题的答案会直接改变实现范围，建议在进入阶段 1 前逐条确认：

1. **编排对象**：第一版的目标场景是「单个 issue 内的多阶段流水线」，还是「一个项目/父 issue 下的跨 issue 编排」？本方案按前者设计。
2. **执行者**：阶段是否必须支持「人」作为执行者，还是只编排 agent？本方案默认支持 agent + member + approval。
3. **人工审批**：第一版是否必须有人工审批门？如果不需要，MVP 可以再小一圈。
4. **跨 agent 代码交接**：是否要求「实现 agent → 评审 agent」在同一个代码分支上工作？如果是，8.3 的 B 方案（分支传递）必须进入第一版，范围会显著扩大。
5. **阶段完成信号**：是否接受「任务成功完成 = 阶段完成」，还是必须由 agent 显式给出 pass/fail verdict？后者需要新的 CLI/协议。
6. **issue 状态归属**：run 期间由引擎控制 issue 状态（启动设 in_progress、完成设 done），还是继续由 agent/人控制？本方案建议引擎控制，并在 prompt 中禁止 agent 改状态。
7. **assignee 语义**：run 期间 assignee 是否跟随阶段执行者？（D6）
8. **启动方式**：第一版只需要手动启动，还是必须支持「issue 创建/打标签时自动启动」？
9. **模板范围**：模板是 workspace 私有，还是需要内置模板/跨 workspace 导入导出？
10. **失败默认值**：失败后默认暂停等人处理，还是自动重试一次再暂停？默认重试上限和超时时间是多少？
11. **历史数据**：已存在的 issue 是否需要在 UI 上隐藏 Workflow 入口，还是所有 issue 都可以启动？
12. **删除语义**：模板删除用软删除还是硬删除？历史 run 是否长期保留？
13. **驳回语义**：审批驳回后是结束当前 run（本方案默认），还是必须自动回到上一个执行阶段？后者需要引入受控回边和最大循环次数。

---

## 18. 本版的明确缺口

- **没有任何实现**：没有迁移、没有接口、没有前端代码。本文件是唯一交付物。
- **没有最终 API 契约**：第 10 节是示意，字段名和错误码会在实现前细化。
- **没有视觉设计**：没有线框图、没有组件拆分、没有移动端适配方案；交互细节需在实现前确认。
- **没有跨 agent 分支交接的完整方案**：8.3 只给出方向，daemon/execenv 的改动需要单独设计。
- **没有容量/性能评估**：没有估算 run/stage 表增长、对账扫描成本、通知量。
- **没有权限矩阵的最终版本**：第 12 节是原则，具体到每个 endpoint 的 role 校验需要实现时逐条确认。
- **没有 prompt 注入防护设计**：阶段指令与 issue 描述同信任级，是否需要额外隔离未评估。
- **没有国际化方案**：新增 UI 文案目前按仓库现状只提供英文。
- **没有与 projects/labels 的联动**：第一版模板是 workspace 级，不按项目过滤。

---

## 19. 代码索引（写实现前先读）

| 主题 | 文件 |
|---|---|
| 任务生命周期 | `server/internal/service/task.go` |
| 任务队列 SQL | `server/pkg/db/queries/agent.sql`、`server/migrations/001_init.up.sql`（`agent_task_queue`） |
| 任务字段演进 | `server/migrations/003_task_context.up.sql`、`020_task_session.up.sql`、`028_task_trigger_comment.up.sql`、`033_chat.up.sql`、`037_fix_pending_task_unique_index.up.sql` |
| issue 触发逻辑 | `server/internal/handler/issue.go:888`、`:1081-1088`、`:1129`、`:1136`、`:1159` |
| 评论/mention 触发 | `server/internal/handler/comment.go:263`、`:369` |
| daemon claim / prompt | `server/internal/handler/daemon.go:341`、`server/internal/daemon/prompt.go` |
| 事件总线 | `server/internal/events/bus.go` |
| 监听器模式 | `server/cmd/server/activity_listeners.go`、`subscriber_listeners.go`、`notification_listeners.go` |
| 定时任务模式 | `server/cmd/server/runtime_sweeper.go` |
| 路由 | `server/cmd/server/router.go` |
| 前端导航 | `packages/views/layout/app-sidebar.tsx` |
| issue 详情属性栏 | `packages/views/issues/components/issue-detail.tsx:1175` |
| agent 页面模式（可复用） | `packages/views/agents/components/agents-page.tsx` |
| 设计规范 | `docs/design.md` |
| 既有实现计划格式 | `docs/plans/*.md` |

---

## 附录 A：示例 definition

```json
{
  "stages": [
    {
      "key": "implement",
      "name": "实现",
      "kind": "agent",
      "actor_type": "agent",
      "actor_id": "<agent-uuid>",
      "instructions": "实现 issue 描述中的功能。完成后在 issue 下评论说明改动，不要修改 issue 状态。",
      "on_failure": { "strategy": "retry", "max_attempts": 2 },
      "timeout_seconds": 3600
    },
    {
      "key": "review",
      "name": "代码评审",
      "kind": "agent",
      "actor_type": "agent",
      "actor_id": "<agent-uuid>",
      "instructions": "评审当前改动，给出明确结论并评论。",
      "on_failure": { "strategy": "pause" }
    },
    {
      "key": "acceptance",
      "name": "人工验收",
      "kind": "approval",
      "approver": { "type": "member", "id": "<member-uuid>" },
      "instructions": "确认功能符合预期后通过。"
    }
  ],
  "on_complete": { "issue_status": "done" }
}
```

## 附录 B：一次典型运行时序

```
用户            Web/API                 WorkflowService            TaskService            daemon
 |  启动 run      |                          |                        |                    |
 |--------------->|  校验/建 run+stage#1     |                        |                    |
 |                |------------------------->|  派发 stage#1          |                    |
 |                |                          |----------------------->|  建 task + stage_id |
 |                |                          |                        |------------------->| claim
 |                |                          |                        |                    | 执行
 |                |                          |   task:completed       |                    |
 |                |                          |<-----------------------|                    |
 |                |   stage#1 completed      |  推进 stage#2          |                    |
 |                |<-------------------------|----------------------->|  建 task            |
 |                |                          |                        |                    |
 |                |   stage#2 ...            |                        |                    |
 |                |                          |  进入 approval         |                    |
 |                |                          |  建 inbox 通知         |                    |
 |  审批通过       |                          |                        |                    |
 |--------------->|  approve                 |  下一阶段/完成 run     |                    |
```

---

_本文件是讨论稿，不是实现承诺。评审意见请直接开在 PR 或 issue #1 下。_
