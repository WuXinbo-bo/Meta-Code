# Meta Code Desktop

此目录只保存桌面 Launcher 源码。开发工作台仍从仓库根目录运行，打包不会改写 `dist/`、`dist-server/`、`.runtime/` 或个人数据。

默认产物目录位于仓库的同级目录之外：

```text
../Meta-Code-Packages/0.1.2/
```

桌面版使用 Electron 自带的固定 Node 运行时启动编译后的后端，随机选择本地端口，不占用开发版的 `4338/4339`。个人数据继续保存在 `%USERPROFILE%\.metacode`；卸载程序不得删除该目录。

```powershell
npm run desktop:package:dir # 只生成解包目录，适合快速验证
npm run desktop:package     # 生成安装包与便携版
```

安装版使用 `desktop/installer.nsh` 中的 Meta Code 品牌页面，展示实际安装阶段和进度；不使用模拟百分比。在线更新下载仍由独立 Launcher 在配置正式发布源后承接。
