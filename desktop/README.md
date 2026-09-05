# Meta Code Desktop

此目录只保存桌面 Launcher 源码。开发工作台仍从仓库根目录运行。打包会重新生成 `dist/` 和 `dist-server/`，但安装产物独立存放，不修改开发配置、`.runtime/` 或个人数据。

默认产物目录位于仓库的同级目录之外：

```text
../Meta-Code-Packages/0.1.4/
```

桌面版使用 Electron 自带的固定 Node 运行时启动编译后的后端，随机选择本地端口，不占用开发版的 `4338/4339`。个人数据继续保存在 `%USERPROFILE%\.metacode`；卸载程序不得删除该目录。

安装包另行携带经过校验的 Node/npm 工具链供 CLI 安装使用，新电脑无需先配置系统 npm。可通过 `METACODE_PACKAGE_ROOT` 指定独立产物目录，例如被 Git 忽略的 `release-artifacts/desktop`。

```powershell
npm run desktop:package:dir # 只生成解包目录，适合快速验证
npm run desktop:package     # 生成安装包与便携版
```

安装版使用 `desktop/installer.nsh` 中的 Meta Code 品牌页面，展示实际安装阶段和进度；不使用模拟百分比。在线更新下载仍由独立 Launcher 在配置正式发布源后承接。
