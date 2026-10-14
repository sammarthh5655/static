; ---------------------------------------------------------------------------
; static's Windows installer: register static as a web browser.
;
; Without this, Windows does not know static is a browser: it never appears
; in Settings > Apps > Default apps, and "Open with" does not offer it for web
; pages. With it, static is listed there like Chrome or Brave, and the person
; can choose it. Windows 10 and 11 do not let an installer MAKE itself the
; default - that choice is always the person's, in Settings.
;
; Written to SHCTX, which is HKEY_CURRENT_USER for this per-user install (no
; administrator rights needed) and would be HKEY_LOCAL_MACHINE for a
; per-machine one. Everything written here is removed on uninstall.
;
; Links and files then arrive as command-line arguments ("%1"); the app opens
; them in a tab (src/main/system-open.js decides what is accepted).
;
; Included by electron-builder via nsis.include in electron-builder.config.cjs.
; ---------------------------------------------------------------------------

!define STATIC_CLIENT    "StaticBrowser"
!define STATIC_HTML      "StaticBrowserHTML"
!define STATIC_URL       "StaticBrowserURL"
!define STATIC_EXE       "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
!define STATIC_CLIENTKEY "Software\Clients\StartMenuInternet\${STATIC_CLIENT}"
!define STATIC_CAPS      "${STATIC_CLIENTKEY}\Capabilities"

; The Arm64 installer on an ordinary x64 PC would first uninstall the
; working static (that happens before files are copied) and then have no
; files for this PC to install. Refuse at once instead, before anything is
; changed. customInit runs in .onInit, ahead of the install section.
!macro customInit
  !ifdef APP_ARM64
    !ifndef APP_64
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP "This installer is for Windows on Arm computers. Please download the standard Windows installer (static-setup.exe) instead." /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
    !endif
  !endif
!macroend

; One ProgID per kind of thing opened: a document, and a link.
!macro staticProgId ID LABEL
  WriteRegStr SHCTX "Software\Classes\${ID}" "" "${LABEL}"
  WriteRegStr SHCTX "Software\Classes\${ID}" "FriendlyTypeName" "${LABEL}"
  WriteRegStr SHCTX "Software\Classes\${ID}\Application" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Classes\${ID}\Application" "ApplicationIcon" "${STATIC_EXE},0"
  WriteRegStr SHCTX "Software\Classes\${ID}\DefaultIcon" "" "${STATIC_EXE},0"
  WriteRegStr SHCTX "Software\Classes\${ID}\shell\open\command" "" '"${STATIC_EXE}" "%1"'
!macroend

!macro staticFileAssoc EXT
  WriteRegStr SHCTX "${STATIC_CAPS}\FileAssociations" "${EXT}" "${STATIC_HTML}"
  ; "Open with" list, without taking over the extension.
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${STATIC_HTML}" ""
!macroend

!macro customInstall
  !insertmacro staticProgId "${STATIC_HTML}" "${PRODUCT_NAME} HTML Document"
  !insertmacro staticProgId "${STATIC_URL}" "${PRODUCT_NAME} URL"
  WriteRegStr SHCTX "Software\Classes\${STATIC_URL}" "URL Protocol" ""

  ; The browser itself, as Windows lists browsers.
  WriteRegStr SHCTX "${STATIC_CLIENTKEY}" "" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "${STATIC_CLIENTKEY}\DefaultIcon" "" "${STATIC_EXE},0"
  WriteRegStr SHCTX "${STATIC_CLIENTKEY}\shell\open\command" "" '"${STATIC_EXE}"'
  WriteRegStr SHCTX "${STATIC_CAPS}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "${STATIC_CAPS}" "ApplicationIcon" "${STATIC_EXE},0"
  WriteRegStr SHCTX "${STATIC_CAPS}" "ApplicationDescription" "static is a fast, private web browser with real Chrome extensions."
  WriteRegStr SHCTX "${STATIC_CAPS}\StartMenu" "StartMenuInternet" "${STATIC_CLIENT}"
  WriteRegStr SHCTX "${STATIC_CAPS}\URLAssociations" "http" "${STATIC_URL}"
  WriteRegStr SHCTX "${STATIC_CAPS}\URLAssociations" "https" "${STATIC_URL}"
  !insertmacro staticFileAssoc ".htm"
  !insertmacro staticFileAssoc ".html"
  !insertmacro staticFileAssoc ".shtml"
  !insertmacro staticFileAssoc ".xht"
  !insertmacro staticFileAssoc ".xhtml"
  !insertmacro staticFileAssoc ".svg"
  !insertmacro staticFileAssoc ".webp"
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCT_NAME}" "${STATIC_CAPS}"

  ; Tell Explorer and Settings that associations changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro staticForgetExt EXT
  DeleteRegValue SHCTX "Software\Classes\${EXT}\OpenWithProgids" "${STATIC_HTML}"
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller first; the new version writes all of
  ; this again straight after, so leave it in place rather than flicker the
  ; person's default-browser choice.
  ${ifNot} ${isUpdated}
    DeleteRegKey SHCTX "Software\Classes\${STATIC_HTML}"
    DeleteRegKey SHCTX "Software\Classes\${STATIC_URL}"
    DeleteRegKey SHCTX "${STATIC_CLIENTKEY}"
    DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCT_NAME}"
    !insertmacro staticForgetExt ".htm"
    !insertmacro staticForgetExt ".html"
    !insertmacro staticForgetExt ".shtml"
    !insertmacro staticForgetExt ".xht"
    !insertmacro staticForgetExt ".xhtml"
    !insertmacro staticForgetExt ".svg"
    !insertmacro staticForgetExt ".webp"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
