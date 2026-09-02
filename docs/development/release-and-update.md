# Meta Code 发布与更新架构

Meta Code 当前产品版本为 `0.1.1`。`package.json` 是唯一版本源；代码、发布清单和设置页不得各自维护版本常量。

## 运行边界

- 工作台负责版本检查、频道偏好、更新公告、跳过版本和稍后提醒。
- 独立 Launcher 负责下载、SHA-256/签名校验、进程退出、原子切换和失败回滚。
- 工作台不会对正在运行的源码执行 `git pull`，也不会覆盖自身目录。
- 个人数据始终位于 `%USERPROFILE%\.metacode`，卸载或替换程序版本不会删除个人数据。
- 程序版本的目标安装位置为 `%LOCALAPPDATA%\MetaCode\versions\<version>`；活动版本由 Launcher 指针选择。

## 更新来源

`release.config.json` 保存非敏感的产品与兼容协议配置。稳定版固定从 `https://github.com/WuXinbo-bo/Meta-Code/releases/latest/download/latest.json` 获取受校验的发布清单；部署也可使用：

- `METACODE_GITHUB_REPOSITORY`
- `METACODE_UPDATE_MANIFEST_URL`
- `METACODE_UPDATE_MANIFEST_STABLE_URL`
- `METACODE_UPDATE_MANIFEST_BETA_URL`
- `METACODE_UPDATE_CHANNEL`

未配置来源时，设置页明确显示“更新源未配置”，不会从 Git remote 推断地址。Manifest 优先；GitHub Releases API 只作为公告降级来源，不能触发安装。Beta 频道仅接受标记为 prerelease 的 Release，不会回退到稳定版。

## 发布清单

正式 Manifest 包含产品、版本、频道、发布日期、兼容范围、发布说明和平台资产。每个资产必须包含 SHA-256；未来 Launcher 上线前还必须加入可验证签名。

```powershell
npm run release:prepare -- --asset <package.zip> --asset-url <https-url> --release-url <https-url>
```

生成物写入被 Git 忽略的 `release-artifacts/`。推送 `v*` 标签后，GitHub Actions 会在隔离的 Windows Runner 中校验版本、执行发布测试、构建安装包，并生成 `latest.json` 与 `SHA256SUMS.txt` 后发布 Release。签名密钥不进入工作台进程或源码仓库。

## 兼容与回滚

`dataSchemaVersion` 与 `launcherProtocolVersion` 是发布闸门。Launcher 只能应用兼容的 Manifest，并依次执行：下载到临时目录、校验、解包到新版本目录、健康检查、切换活动指针。失败时保留旧版本并恢复指针。数据库迁移必须先备份且保持可重复执行。

当前 `0.1.1` 只开放 `check` 能力；`download`、`apply` 和 `launcher` 能力均为关闭状态。后续 Launcher 接入时通过能力协商开放，而不是在 UI 中伪造进度。
