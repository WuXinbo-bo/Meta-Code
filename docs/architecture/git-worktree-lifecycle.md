# Git Worktree 生命周期

`server/git/worktreeManager.ts` 提供与 UI、任务编排无关的 Worktree 生命周期服务。它复用 `server/git/service.ts` 的 `gitRoot` 和 `runGit`，所有 Git 参数通过 `execFile` 传入，不经过 shell。

## 操作

- `listWorktrees(root)`：读取主 Worktree 与所有关联 Worktree，同时返回锁定、可清理、缺失和 detached 状态。
- `createWorktree({ workspaceRoot, worktreePath, branch?, ref?, detach?, force? })`：创建 Worktree。相对路径只能位于工作区内；绝对路径可用于常见的兄弟目录布局。
- `bindWorktree(root, path)`：只有 Git 已登记的 Worktree 才能绑定任务。
- `restoreWorktree(root, path)`：执行 `git worktree repair`，用于 Worktree 移动或恢复后的 Git 管理信息修复。
- `preflightMerge({ workspaceRoot, source, target?, worktreePath?, allowDirty? })`：用 `merge-tree --write-tree` 做无副作用合并预检，返回 `ready`、`already_up_to_date`、`conflicts` 或 `blocked`。
- `cleanupWorktree(root, path, force?)`：主工作区、未登记路径、锁定 Worktree 和脏 Worktree 默认拒绝删除；只有显式 `force` 才能清理后两者。

路径错误、非 Git 工作区和 Git 生命周期失败统一抛出 `WorktreeError`，其中 `code` 可由 API 层映射为稳定的错误类型。需要显示给用户的可恢复状态（例如脏 Worktree 或锁定 Worktree）通过结构化的 `blocked` 返回，不要求调用方解析 Git 文本。

## 安全边界

相对路径不能越过工作区；主工作区和 `.git` 目录不能作为关联 Worktree。清理操作还要求路径与 `git worktree list --porcelain` 的登记记录精确匹配，避免误删工作区之外的目录。比较路径时使用 `realpath`，因此 macOS `/var` 与 `/private/var` 的别名不会造成重复 Worktree。

## 验证

运行 `npm run test:git-worktree-manager`（或在无 npm 的开发环境中执行 `node --import tsx scripts/test-git-worktree-manager.mjs`）可覆盖创建、重复创建、绑定、合并预检、脏状态阻断、恢复、强制清理、非 Git 路径和路径边界。
