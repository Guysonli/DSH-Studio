; DSH Studio 安装/卸载脚本

; ---- 安装前检测 ----
!macro customInit
  ReadRegStr $0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{#UNINSTALL_APP_KEY}" "DisplayVersion"
  ReadRegStr $1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{#UNINSTALL_APP_KEY}" "UninstallString"

  ${If} $1 != ""
    ${If} $0 == ""
      MessageBox MB_YESNO|MB_ICONEXCLAMATION "检测到已安装的 DSH Studio。$\n$\n是否卸载旧版本后重新安装？" IDYES doUninstall IDNO continueInstall
    ${ElseIf} $0 == "${VERSION}"
      Goto continueInstall
    ${Else}
      MessageBox MB_YESNO|MB_ICONINFORMATION "检测到 DSH Studio $0 已安装。$\n$\n当前安装版本: ${VERSION}$\n$\n是否卸载旧版本后安装？" IDYES doUninstall IDNO continueInstall
    ${EndIf}

    doUninstall:
      ExecWait '$1 /S'
      Goto continueInstall

    continueInstall:
  ${EndIf}
!macroend

; ---- 安装完成：确保桌面快捷方式显示新图标 ----
!macro customInstall
  ; 删除并重建桌面快捷方式（$DESKTOP 即 electron-builder 创建快捷方式的位置；
  ; 新 .lnk 文件强制资源管理器重新提取 exe 图标）
  Delete "$DESKTOP\DSH Studio.lnk"
  CreateShortCut "$DESKTOP\DSH Studio.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ; 清理图标缓存数据库（explorer 锁定时会跳过；ie4uinit 补强）
  Delete "$LOCALAPPDATA\IconCache.db"
  Delete "$LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache_*"
  ${If} ${FileExists} "$SYSDIR\ie4uinit.exe"
    ExecWait '"$SYSDIR\ie4uinit.exe" -show'
  ${EndIf}
!macroend

; ---- 卸载时清理 ----
!macro customUnInstall
  ; 删除开始菜单快捷方式
  RMDir /r "$SMPROGRAMS\DSH Studio"
  Delete "$DESKTOP\DSH Studio.lnk"

  ; 删除用户数据目录（可选）
  RMDir /r "$LOCALAPPDATA\DSH Studio"
  RMDir /r "$APPDATA\DSH Studio"

  ; 删除注册表卸载项
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\{#UNINSTALL_APP_KEY}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\{#UNINSTALL_APP_KEY}"

  ; 删除安装目录残留
  RMDir /r "$INSTDIR"
!macroend
