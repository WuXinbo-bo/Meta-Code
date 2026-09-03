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

正式 Manifest v2 包含产品、SemVer、不可变 build ID、频道、发布日期、兼容范围、发布说明和平台资产。每个资产必须包含 SHA-256，整个清单必须通过受信任密钥的 Ed25519 签名；无签名、未知密钥或内容被篡改的清单一律拒绝。公开密钥进入 `release.config.json`，私钥只保存在本地安全目录和 GitHub Actions Secret `METACODE_MANIFEST_SIGNING_KEY_B64` 中。

```powershell
npm run release:prepare -- --asset <package.zip> --asset-url <https-url> --release-url <https-url> --build-id <git-sha> --signing-key <private.pem> --signing-key-id meta-code-release-2026
```

生成物写入被 Git 忽略的 `release-artifacts/`。推送 `v*` 标签后，GitHub Actions 会在隔离的 Windows Runner 中校验版本、执行发布测试、构建安装包，并生成 `latest.json` 与 `SHA256SUMS.txt` 后发布 Release。重复执行同一标签时会覆盖同名资产，不会因 Release 已存在而失败。签名密钥不进入工作台进程或源码仓库。

## 兼容与回滚

兼容闸门不再把“目标写入版本”误当成“当前必须版本”。Manifest 分别声明 `readsFrom`、`migratesFrom`、`writesTo`、迁移协议和禁止降级策略；因此 Schema 1 可以安全升级到写入 Schema 2，而 Schema 3 不会被旧程序覆盖。Launcher 协议同样使用范围协商。Launcher 只能应用兼容的 Manifest，并依次执行：下载到临时目录、校验、解包到新版本目录、健康检查、切换活动指针。失败时保留旧版本并恢复指针。数据库迁移必须先备份且保持可重复执行。

检查请求使用系统代理环境并对超时、限流和服务端错误进行有限退避重试。当前检查失败时，设置页会把错误与“上次成功结果”分开显示，避免把缓存公告误报成刚刚检查成功。同一 SemVer 的紧急资源替换由 build ID 识别，正式发布仍应优先递增补丁版本。

当前 `0.1.1` 只开放 `check` 能力；`download`、`apply` 和 `launcher` 能力均为关闭状态。后续 Launcher 接入时通过能力协商开放，而不是在 UI 中伪造进度。

## 发布不变量

- 旧程序只能读取其明确声明可读的数据版本，不能猜测新版 Schema。
- 数据迁移先创建完整校验备份，再运行可重复迁移；失败时原数据库保持不变。
- `writesTo` 表示新程序完成迁移后的写入版本，不等于安装前数据必须已经处于该版本。
- 更新清单签名、资产 SHA-256、产品 ID、平台、Launcher 协议和数据兼容范围必须全部通过后才能进入切换阶段。
- CLI 更新与应用更新是两套独立事务。CLI 切换还必须通过 Provider/ACP、委派和编排能力认证，不能只以 `--version` 成功作为依据。
- 发布工作流可以幂等重跑同一标签，但正式修复应提升 SemVer；build ID 只用于识别同版本不同构建，不替代版本治理。
- 发布密钥、个人数据、开发 API token、安装包中间产物均不得进入 Git 历史。

## 本地 API 边界

桌面启动器为每次启动生成随机 API token，并由 Electron 请求层注入；开发版由后端和 Vite 代理共享 `.metacode-development/security/api-token`。除健康检查和已有独立桥接令牌的内部端点外，所有 `/api/*` 请求都必须满足 loopback Host、允许端口和 token 校验。浏览器写请求还要通过 Origin 与 `Sec-Fetch-Site` 检查，从而阻止恶意网页和 DNS rebinding 直接控制本地工作台，而不引入登录界面或多用户系统。
