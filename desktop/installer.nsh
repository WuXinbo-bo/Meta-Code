!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING

!macro customHeader
  BrandingText "Meta Code ${VERSION}"
!macroend

!ifndef BUILD_UNINSTALLER
  !define MUI_WELCOMEPAGE_TITLE "安装 Meta Code ${VERSION}"
  !define MUI_WELCOMEPAGE_TEXT "本地优先的多 Agent 开发工作台。$\r$\n$\r$\n安装程序只写入程序文件，不会删除或覆盖保存在用户目录中的会话、工作区、Skill、MCP 与模型配置。"
  !define MUI_FINISHPAGE_TITLE "Meta Code 已准备就绪"
  !define MUI_FINISHPAGE_TEXT "程序文件已完成安装。个人数据与程序版本相互独立，后续升级和卸载默认保留用户数据。"
  !define MUI_FINISHPAGE_RUN_TEXT "启动 Meta Code"
  !define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !define MUI_FINISHPAGE_NOAUTOCLOSE

  !macro customWelcomePage
    !insertmacro MUI_PAGE_WELCOME
  !macroend

  !macro customPageAfterChangeDir
    Page custom MetaCodeInstallSummaryCreate
  !macroend

  !macro customFinishPage
    !insertmacro MUI_PAGE_FINISH
  !macroend

  Function MetaCodeInstallSummaryCreate
    !insertmacro MUI_HEADER_TEXT "准备安装" "确认 Meta Code 的安装位置与数据边界"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 4u 100% 18u "Meta Code ${VERSION}"
    Pop $1
    CreateFont $2 "$(^Font)" 12 600
    SendMessage $1 ${WM_SETFONT} $2 1

    ${NSD_CreateLabel} 0 30u 100% 22u "程序将安装到：$\r$\n$INSTDIR"
    Pop $1
    ${NSD_CreateHLine} 0 61u 100% 1u ""
    Pop $1
    ${NSD_CreateLabel} 0 72u 100% 28u "用户数据继续保存在 %USERPROFILE%\.metacode。安装、升级和卸载均不会主动删除该目录。"
    Pop $1
    ${NSD_CreateLabel} 0 112u 100% 22u "下一步将显示真实的文件写入进度。"
    Pop $1

    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:开始安装"
    nsDialogs::Show
  FunctionEnd
!endif
