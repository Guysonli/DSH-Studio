; DSH Studio 安装脚本 — 检测旧版并引导卸载
!macro customInit
  ; 检测旧版安装路径（HKLM，per-machine 安装）
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{#UNINSTALL_APP_KEY}" "UninstallString"
  ${If} $0 == ""
    ; 也检查 HKCU（per-user 安装）
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{#UNINSTALL_APP_KEY}" "UninstallString"
  ${EndIf}
  ${If} $0 != ""
    MessageBox MB_YESNO|MB_ICONQUESTION "Found existing DSH Studio installation.$\n$\nUninstall old version first?$\n$\nYes = Uninstall old, then install new$\nNo = Install new over old" IDYES uninstallOld IDNO skipUninstall

    uninstallOld:
      ExecWait '$0 /S _?=$0'
      Goto skipUninstall

    skipUninstall:
  ${EndIf}
!macroend
