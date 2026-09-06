Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include WinMessages.nsh
!include "Win\WinUser.nsh"
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND "{{uninstaller_sign_cmd}}"
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName

; Fleet's installer is a single branded surface rather than a page-by-page wizard.
; Fleet UI palette - mirrors src/renderer/styles.css (Obsidian dark theme)
; so the installer reads as the same product as the app.
!define FLEET_BG 0x08090B
!define FLEET_RAIL 0x0C0D10
!define FLEET_SURFACE 0x111217
!define FLEET_SURFACE2 0x17181E
!define FLEET_SURFACE3 0x1D1E25
!define FLEET_HAIR 0x202128
!define FLEET_TEXT 0xF4F0F1
!define FLEET_INK2 0xAAA3A7
!define FLEET_INK3 0x726C71
!define FLEET_ACCENT 0x2563EB
!define FLEET_ACCENT2 0x3B82F6
!define FLEET_ONACCENT 0xF8FBFF
!define FLEET_DANGER 0xDC4259
!define FLEET_DANGER2 0xE8556B

!define /ifndef SS_NOTIFY 0x00000100
!define /ifndef SS_CENTER 0x00000001
!define /ifndef SS_CENTERIMAGE 0x00000200
!define /ifndef PBM_SETBARCOLOR 0x0409
!define /ifndef PBM_SETBKCOLOR 0x2001
!define /ifndef WS_CAPTION 0x00C00000
!define /ifndef WS_THICKFRAME 0x00040000
!define /ifndef SWP_FRAMECHANGED 0x0020
!define /ifndef IDC_CHILDRECT 1044

Var FleetDialog
Var FleetTitleBar
Var FleetTitleBarText
Var FleetMinimizeButton
Var FleetWindowCloseButton
Var FleetLogo
Var FleetLogoImage
Var FleetVersionLabel
Var FleetTitle
Var FleetSubtitle
Var FleetFeatureBand
Var FleetPathLabel
Var FleetPathField
Var FleetBrowseButton
Var FleetDesktopCheckbox
Var FleetDesktopShortcutState
Var FleetInstallButton
Var FleetCancelButton
Var FleetActionText
Var FleetProgressDialog
Var FleetProgressBar
Var FleetFinishDialog
Var FleetLaunchButton
Var FleetCloseButton
Var FleetFontBrand
Var FleetFontTitle
Var FleetFontBody
Var FleetFontSmall
Var FleetFontButton

Name "${PRODUCTNAME}"
Caption "Fleet Installer"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

# additional plugins
!addplugindir "${ADDITIONALPLUGINSPATH}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Fleet GUI init: style the wizard window before the first page is shown,
; so the stock caption never flashes.
!define MUI_CUSTOMFUNCTION_GUIINIT FleetGuiInit
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.FleetGuiInit

; Detect an existing installation before showing Fleet's custom surface.
Var ReinstallPageCheck
Page custom PageReinstall PageLeaveReinstall
Function PageReinstall
  ; Uninstall previous WiX installation if exists.
  ;
  ; A WiX installer stores the installation info in registry
  ; using a UUID and so we have to loop through all keys under
  ; `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`
  ; and check if `DisplayName` and `Publisher` keys match ${PRODUCTNAME} and ${MANUFACTURER}
  ;
  ; This has a potential issue that there maybe another installation that matches
  ; our ${PRODUCTNAME} and ${MANUFACTURER} but wasn't installed by our WiX installer,
  ; however, this should be fine since the user will have to confirm the uninstallation
  ; and they can chose to abort it if doesn't make sense.
  StrCpy $0 0
  wix_loop:
    EnumRegKey $1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" wix_loop_done ; Exit loop if there is no more keys to loop on
    IntOp $0 $0 + 1
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "DisplayName"
    ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "Publisher"
    StrCmp "$R0$R1" "${PRODUCTNAME}${MANUFACTURER}" 0 wix_loop
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1" "UninstallString"
    ${StrCase} $R1 $R0 "L"
    ${StrLoc} $R0 $R1 "msiexec" ">"
    StrCmp $R0 0 0 wix_loop_done
    StrCpy $WixMode 1
    StrCpy $R6 "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$1"
    Goto compare_version
  wix_loop_done:

  ; Check if there is an existing installation, if not, abort the reinstall page
  ReadRegStr $R0 SHCTX "${UNINSTKEY}" ""
  ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
  ${IfThen} "$R0$R1" == "" ${|} Abort ${|}

  ; Compare this installar version with the existing installation
  ; and modify the messages presented to the user accordingly
  compare_version:
  StrCpy $R4 "$(older)"
  ${If} $WixMode = 1
    ReadRegStr $R0 HKLM "$R6" "DisplayVersion"
  ${Else}
    ReadRegStr $R0 SHCTX "${UNINSTKEY}" "DisplayVersion"
  ${EndIf}
  ${IfThen} $R0 == "" ${|} StrCpy $R4 "$(unknown)" ${|}

  nsis_tauri_utils::SemverCompare "${VERSION}" $R0
  Pop $R0
  ; Reinstalling the same version
  ${If} $R0 = 0
    StrCpy $R1 "$(alreadyInstalledLong)"
    StrCpy $R2 "$(addOrReinstall)"
    StrCpy $R3 "$(uninstallApp)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(chooseMaintenanceOption)"
  ; Upgrading
  ${ElseIf} $R0 = 1
    StrCpy $R1 "$(olderOrUnknownVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    StrCpy $R3 "$(dontUninstall)"
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ; Downgrading
  ${ElseIf} $R0 = -1
    StrCpy $R1 "$(newerVersionInstalled)"
    StrCpy $R2 "$(uninstallBeforeInstalling)"
    !if "${ALLOWDOWNGRADES}" == "true"
      StrCpy $R3 "$(dontUninstall)"
    !else
      StrCpy $R3 "$(dontUninstallDowngrade)"
    !endif
    !insertmacro MUI_HEADER_TEXT "$(alreadyInstalled)" "$(choowHowToInstall)"
  ${Else}
    Abort
  ${EndIf}

  ; Skip showing the page if passive
  ;
  ; Note that we don't call this earlier at the begining
  ; of this function because we need to populate some variables
  ; related to current installed version if detected and whether
  ; we are downgrading or not.
  ; Updates and same-version repairs continue without exposing a maintenance wizard.
  !if "${ALLOWDOWNGRADES}" == "false"
    ${If} $R0 = -1
      MessageBox MB_ICONSTOP "A newer version of Fleet is already installed."
      Quit
    ${EndIf}
  !endif
  ; Only a genuine upgrade is an update: same-version repairs keep the full
  ; install behaviour (shortcuts, run entries) instead of silently skipping them.
  ${If} $R0 = 1
    StrCpy $UpdateMode 1
  ${EndIf}
  ${If} $WixMode = 1
    Call PageLeaveReinstall
  ${EndIf}
  Abort
FunctionEnd
Function PageReinstallUpdateSelection
  ${NSD_GetState} $R2 $R1
  ${If} $R1 == ${BST_CHECKED}
    StrCpy $ReinstallPageCheck 1
  ${Else}
    StrCpy $ReinstallPageCheck 2
  ${EndIf}
FunctionEnd
Function PageLeaveReinstall
  ${NSD_GetState} $R2 $R1

  ; If migrating from Wix, always uninstall
  ${If} $WixMode = 1
    Goto reinst_uninstall
  ${EndIf}

  ; In update mode, always proceeds without uninstalling
  ${If} $UpdateMode = 1
    Goto reinst_done
  ${EndIf}

  ; $R0 holds whether same(0)/upgrading(1)/downgrading(-1) version
  ; $R1 holds the radio buttons state:
  ;   1 => first choice was selected
  ;   0 => second choice was selected
  ${If} $R0 = 0 ; Same version, proceed
    ${If} $R1 = 1              ; User chose to add/reinstall
      Goto reinst_done
    ${Else}                    ; User chose to uninstall
      Goto reinst_uninstall
    ${EndIf}
  ${ElseIf} $R0 = 1 ; Upgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${ElseIf} $R0 = -1 ; Downgrading
    ${If} $R1 = 1              ; User chose to uninstall
      Goto reinst_uninstall
    ${Else}
      Goto reinst_done         ; User chose NOT to uninstall
    ${EndIf}
  ${EndIf}

  reinst_uninstall:
    HideWindow
    ClearErrors

    ${If} $WixMode = 1
      ReadRegStr $R1 HKLM "$R6" "UninstallString"
      ExecWait '$R1' $0
    ${Else}
      ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
      ReadRegStr $R1 SHCTX "${UNINSTKEY}" "UninstallString"
      ${IfThen} $UpdateMode = 1 ${|} StrCpy $R1 "$R1 /UPDATE" ${|} ; append /UPDATE
      ${IfThen} $PassiveMode = 1 ${|} StrCpy $R1 "$R1 /P" ${|} ; append /P
      StrCpy $R1 "$R1 _?=$4" ; append uninstall directory
      ExecWait '$R1' $0
    ${EndIf}

    BringToFront

    ${IfThen} ${Errors} ${|} StrCpy $0 2 ${|} ; ExecWait failed, set fake exit code

    ${If} $0 <> 0
    ${OrIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
      ; User cancelled wix uninstaller? return to select un/reinstall page
      ${If} $WixMode = 1
      ${AndIf} $0 = 1602
        Abort
      ${EndIf}

      ; User cancelled NSIS uninstaller? return to select un/reinstall page
      ${If} $0 = 1
        Abort
      ${EndIf}

      ; Other erros? show generic error message and return to select un/reinstall page
      MessageBox MB_ICONEXCLAMATION "$(unableToUninstall)"
      Abort
    ${EndIf}
  reinst_done:
FunctionEnd

Var AppStartMenuFolder

; Tauri's shortcut writer needs the MUI start-menu variables initialized.
; The page is always skipped, so it never appears in Fleet's installer.
!if "${STARTMENUFOLDER}" != ""
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!endif
!define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

Page custom FleetInstallPage FleetInstallLeave
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FleetProgressShow
!define MUI_INSTFILESPAGE_AUTOCLOSE
!insertmacro MUI_PAGE_INSTFILES
Page custom FleetFinishPage

; Hide one piece of the stock NSIS wizard by dialog item id.
!macro FleetHideStockCtl ID
  GetDlgItem $0 $HWNDPARENT ${ID}
  ${If} $0 != 0
    ShowWindow $0 ${SW_HIDE}
  ${EndIf}
!macroend

; Strip every visible piece of the stock wizard chrome: nav buttons,
; header text/bitmap slots, divider lines and the brand strip.
!macro FleetHideWizardChrome
  !insertmacro FleetHideStockCtl 1
  !insertmacro FleetHideStockCtl 2
  !insertmacro FleetHideStockCtl 3
  !insertmacro FleetHideStockCtl 1028
  !insertmacro FleetHideStockCtl 1034
  !insertmacro FleetHideStockCtl 1035
  !insertmacro FleetHideStockCtl 1036
  !insertmacro FleetHideStockCtl 1037
  !insertmacro FleetHideStockCtl 1038
  !insertmacro FleetHideStockCtl 1039
  !insertmacro FleetHideStockCtl 1040
  !insertmacro FleetHideStockCtl 1041
  !insertmacro FleetHideStockCtl 1042
  !insertmacro FleetHideStockCtl 1043
  !insertmacro FleetHideStockCtl 1045
  !insertmacro FleetHideStockCtl 1046
  !insertmacro FleetHideStockCtl 1250
  !insertmacro FleetHideStockCtl 1256
!macroend

Var FleetFontGlyph
Var FleetDpi
Var FleetStatusText
Var FleetProgressNote
Var FleetHairline
Var FleetUninstallButton
Var FleetHoverState

; Fleet owns the whole window: no NSIS caption or resize frame, DWM dark
; mode with Windows 11 rounded corners, taskbar minimize retained, and a
; roomy DPI-scaled canvas instead of NSIS's cramped legacy default.
Function FleetApplyWindowTheme
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i20,*i1,i4)i.r0'
  ${If} $0 != 0
    System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i19,*i1,i4)i.r0'
  ${EndIf}
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i33,*i2,i4)i.r0'

  ${NSD_RemoveStyle} $HWNDPARENT 0x00C40000   ; WS_CAPTION|WS_THICKFRAME
  ${NSD_RemoveStyle} $HWNDPARENT 0x00010000   ; WS_MAXIMIZEBOX
  ${NSD_AddStyle} $HWNDPARENT 0x000A0000      ; WS_SYSMENU|WS_MINIMIZEBOX

  System::Call 'USER32::GetDpiForWindow(p$HWNDPARENT)i.r0'
  ${If} $0 = 0
  ${OrIf} $0 == error
    StrCpy $0 96
  ${EndIf}
  StrCpy $FleetDpi $0

  IntOp $1 $0 * 760
  IntOp $1 $1 / 96
  IntOp $2 $0 * 540
  IntOp $2 $2 / 96
  System::Call 'USER32::GetSystemMetrics(i0)i.r3'
  System::Call 'USER32::GetSystemMetrics(i1)i.r4'
  IntOp $3 $3 - $1
  IntOp $3 $3 / 2
  IntOp $4 $4 - $2
  IntOp $4 $4 / 2
  System::Call 'USER32::SetWindowPos(p$HWNDPARENT,p0,ir3,ir4,ir1,ir2,i0x0024)'

  SetCtlColors $HWNDPARENT ${FLEET_TEXT} ${FLEET_BG}
  !insertmacro FleetHideWizardChrome
FunctionEnd

; MUI normally reserves a header and a navigation footer. Expand the
; custom-page reference rectangle over the complete client area instead.
Function FleetPrepareFullCanvas
  System::Call 'USER32::GetClientRect(p$HWNDPARENT,@r0)'
  System::Call '*$0(i,i,i.r3,i.r4)'
  GetDlgItem $0 $HWNDPARENT ${IDC_CHILDRECT}
  ${If} $0 != 0
    System::Call 'USER32::MoveWindow(pr0,i0,i0,ir3,ir4,i0)'
  ${EndIf}
FunctionEnd

Function FleetCreateFonts
  ${If} $FleetFontTitle == ""
    CreateFont $FleetFontBrand "Segoe UI" 10 600
    CreateFont $FleetFontTitle "Segoe UI" 15 700
    CreateFont $FleetFontBody "Segoe UI" 9 400
    CreateFont $FleetFontSmall "Segoe UI" 7 600
    CreateFont $FleetFontButton "Segoe UI" 9 600
    CreateFont $FleetFontGlyph "Segoe MDL2 Assets" 10 400
  ${EndIf}
FunctionEnd

; Place a control at 96-dpi pixel coordinates, scaled to the window DPI.
; Push x, y, w, h, hwnd in that order.
Function FleetPlacePx
  Pop $R5
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  ${If} $FleetDpi != 96
    IntOp $R6 $R6 * $FleetDpi
    IntOp $R6 $R6 / 96
    IntOp $R7 $R7 * $FleetDpi
    IntOp $R7 $R7 / 96
    IntOp $R8 $R8 * $FleetDpi
    IntOp $R8 $R8 / 96
    IntOp $R9 $R9 * $FleetDpi
    IntOp $R9 $R9 / 96
  ${EndIf}
  System::Call 'USER32::MoveWindow(p$R5,i$R6,i$R7,i$R8,i$R9,i1)'
FunctionEnd

; One flat titlebar shared by every Fleet surface: logo, wordmark, hairline
; and Windows caption buttons drawn with the real Segoe MDL2 caption glyphs.
Function FleetCreateTitleBar
  ${NSD_CreateLabel} 0 0 100% 8.2% ""
  Pop $FleetTitleBar
  SetCtlColors $FleetTitleBar ${FLEET_TEXT} ${FLEET_BG}
  ${NSD_OnClick} $FleetTitleBar FleetDragWindow

  ${NSD_CreateIcon} 2% 1.1% 4.4% 6.1% ""
  Pop $FleetLogo
  !if "${INSTALLERICON}" != ""
    ${NSD_SetIcon} $FleetLogo "${INSTALLERICON}" $FleetLogoImage
  !else
    ${NSD_SetIconFromInstaller} $FleetLogo $FleetLogoImage
  !endif

  ${NSD_CreateLabel} 8% 0 60% 8.2% "Fleet"
  Pop $FleetTitleBarText
  SetCtlColors $FleetTitleBarText ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetTitleBarText ${WM_SETFONT} $FleetFontBrand 1

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 84% 0 8% 8.2% ""
  Pop $FleetMinimizeButton
  SetCtlColors $FleetMinimizeButton ${FLEET_INK2} ${FLEET_BG}
  SendMessage $FleetMinimizeButton ${WM_SETFONT} $FleetFontGlyph 1
  ${NSD_OnClick} $FleetMinimizeButton FleetMinimize

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 92% 0 8% 8.2% ""
  Pop $FleetWindowCloseButton
  SetCtlColors $FleetWindowCloseButton ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetWindowCloseButton ${WM_SETFONT} $FleetFontGlyph 1
  ${NSD_OnClick} $FleetWindowCloseButton FleetCancel

  ; pixel-exact chrome: 44px bar, 46px caption buttons
  Push 16
  Push 6
  Push 32
  Push 32
  Push $FleetLogo
  Call FleetPlacePx
  Push 56
  Push 0
  Push 260
  Push 44
  Push $FleetTitleBarText
  Call FleetPlacePx

  System::Call 'USER32::GetClientRect(p$HWNDPARENT,@r0)'
  System::Call '*$0(i,i,i.r1,i.r2)'
  IntOp $R4 $FleetDpi * 46
  IntOp $R4 $R4 / 96
  IntOp $R5 $FleetDpi * 44
  IntOp $R5 $R5 / 96
  IntOp $R6 $1 - $R4
  IntOp $R6 $R6 - $R4
  IntOp $R7 $1 - $R4
  System::Call 'USER32::MoveWindow(p$FleetMinimizeButton,iR6,i0,iR4,iR5,i1)'
  System::Call 'USER32::MoveWindow(p$FleetWindowCloseButton,iR7,i0,iR4,iR5,i1)'

  ; hairline separator under the bar
  ${NSD_CreateLabel} 0 8.2% 100% 1u ""
  Pop $FleetHairline
  SetCtlColors $FleetHairline ${FLEET_HAIR} ${FLEET_HAIR}

  ; keep the drag fill below every sibling
  System::Call 'USER32::SetWindowPos(p$FleetTitleBar,p1,i0,i0,i0,i0,i0x0013)'
FunctionEnd

; Live hover for the caption glyphs and the primary action, driven by a
; 60ms nsDialogs timer while a Fleet page is on screen. State bits:
; 1 = minimize, 2 = close, 4 = primary action.
Function FleetHoverPoll
  System::Call 'USER32::GetCursorPos(@r5)'
  System::Call '*$5(i.r1,i.r2)'
  StrCpy $R0 0

  ${If} $FleetMinimizeButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetMinimizeButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 1
    ${EndIf}
  ${EndIf}

  ${If} $FleetWindowCloseButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetWindowCloseButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 2
    ${EndIf}
  ${EndIf}

  ${If} $FleetInstallButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetInstallButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 4
    ${EndIf}
  ${ElseIf} $FleetLaunchButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetLaunchButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 4
    ${EndIf}
  ${ElseIf} $FleetUninstallButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetUninstallButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 4
    ${EndIf}
  ${EndIf}

  ${If} $R0 != $FleetHoverState
    StrCpy $FleetHoverState $R0

    IntOp $R1 $R0 & 1
    ${If} $R1 <> 0
      SetCtlColors $FleetMinimizeButton ${FLEET_TEXT} ${FLEET_SURFACE2}
    ${Else}
      SetCtlColors $FleetMinimizeButton ${FLEET_INK2} ${FLEET_BG}
    ${EndIf}
    System::Call 'USER32::InvalidateRect(p$FleetMinimizeButton,p0,i1)'

    IntOp $R1 $R0 & 2
    ${If} $R1 <> 0
      SetCtlColors $FleetWindowCloseButton ${FLEET_ONACCENT} ${FLEET_DANGER}
    ${Else}
      SetCtlColors $FleetWindowCloseButton ${FLEET_TEXT} ${FLEET_BG}
    ${EndIf}
    System::Call 'USER32::InvalidateRect(p$FleetWindowCloseButton,p0,i1)'

    ${If} $FleetInstallButton != ""
      IntOp $R1 $R0 & 4
      ${If} $R1 <> 0
        SetCtlColors $FleetInstallButton ${FLEET_ONACCENT} ${FLEET_ACCENT2}
      ${Else}
        SetCtlColors $FleetInstallButton ${FLEET_ONACCENT} ${FLEET_ACCENT}
      ${EndIf}
      System::Call 'USER32::InvalidateRect(p$FleetInstallButton,p0,i1)'
    ${EndIf}

    ${If} $FleetLaunchButton != ""
      IntOp $R1 $R0 & 4
      ${If} $R1 <> 0
        SetCtlColors $FleetLaunchButton ${FLEET_ONACCENT} ${FLEET_ACCENT2}
      ${Else}
        SetCtlColors $FleetLaunchButton ${FLEET_ONACCENT} ${FLEET_ACCENT}
      ${EndIf}
      System::Call 'USER32::InvalidateRect(p$FleetLaunchButton,p0,i1)'
    ${EndIf}

    ${If} $FleetUninstallButton != ""
      IntOp $R1 $R0 & 4
      ${If} $R1 <> 0
        SetCtlColors $FleetUninstallButton ${FLEET_ONACCENT} ${FLEET_DANGER2}
      ${Else}
        SetCtlColors $FleetUninstallButton ${FLEET_ONACCENT} ${FLEET_DANGER}
      ${EndIf}
      System::Call 'USER32::InvalidateRect(p$FleetUninstallButton,p0,i1)'
    ${EndIf}
  ${EndIf}
FunctionEnd

Function FleetDragWindow
  Pop $0
  System::Call 'USER32::ReleaseCapture()'
  SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} ${HTCAPTION} 0
FunctionEnd

Function FleetMinimize
  Pop $0
  ShowWindow $HWNDPARENT 6
FunctionEnd

Function FleetGuiInit
  Call FleetApplyWindowTheme
FunctionEnd

; Update the live status line on the progress surface. No-op when the
; surface is not on screen (silent installs).
Function FleetStatus
  Pop $R0
  ${If} $FleetStatusText != ""
  ${AndIf} $FleetStatusText != error
  ${AndIf} $FleetStatusText != 0
    SendMessage $FleetStatusText ${WM_SETTEXT} 0 "STR:$R0"
  ${EndIf}
FunctionEnd


Function FleetInstallPage
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}

  Call FleetApplyWindowTheme
  Call FleetCreateFonts
  Call FleetPrepareFullCanvas
  nsDialogs::Create ${IDC_CHILDRECT}
  Pop $FleetDialog
  ${If} $FleetDialog == error
    Abort
  ${EndIf}
  SetCtlColors $FleetDialog ${FLEET_TEXT} ${FLEET_BG}
  StrCpy $FleetHoverState 0
  StrCpy $FleetLaunchButton ""
  StrCpy $FleetUninstallButton ""
  Call FleetCreateTitleBar

  ${NSD_CreateLabel} 6% 11% 70% 5% "FLEET ${VERSION}  ·  WINDOWS 10/11"
  Pop $FleetVersionLabel
  SetCtlColors $FleetVersionLabel ${FLEET_INK3} ${FLEET_BG}
  SendMessage $FleetVersionLabel ${WM_SETFONT} $FleetFontSmall 1

  ${If} $UpdateMode = 1
    StrCpy $FleetActionText "Update Fleet"
  ${Else}
    StrCpy $FleetActionText "Install Fleet"
  ${EndIf}

  ${NSD_CreateLabel} 6% 17% 88% 9% "$FleetActionText"
  Pop $FleetTitle
  SetCtlColors $FleetTitle ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetTitle ${WM_SETFONT} $FleetFontTitle 1

  ${NSD_CreateLabel} 6% 27% 88% 6% "One command center for every Roblox client."
  Pop $FleetSubtitle
  SetCtlColors $FleetSubtitle ${FLEET_INK2} ${FLEET_BG}
  SendMessage $FleetSubtitle ${WM_SETFONT} $FleetFontBody 1

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 6% 34% 88% 13% "MULTI-INSTANCE   ·   LOCAL-FIRST   ·   OPEN SOURCE"
  Pop $FleetFeatureBand
  SetCtlColors $FleetFeatureBand ${FLEET_INK2} ${FLEET_SURFACE}
  SendMessage $FleetFeatureBand ${WM_SETFONT} $FleetFontSmall 1

  ${NSD_CreateLabel} 6% 52% 88% 5% "INSTALL LOCATION"
  Pop $FleetPathLabel
  SetCtlColors $FleetPathLabel ${FLEET_INK3} ${FLEET_BG}
  SendMessage $FleetPathLabel ${WM_SETFONT} $FleetFontSmall 1

  ${NSD_CreateText} 6% 58% 66% 8% "$INSTDIR"
  Pop $FleetPathField
  System::Call 'UXTHEME::SetWindowTheme(p$FleetPathField,w"DarkMode_Explorer",p0)'

  ${NSD_CreateButton} 74% 58% 20% 8% "Browse"
  Pop $FleetBrowseButton
  System::Call 'UXTHEME::SetWindowTheme(p$FleetBrowseButton,w"DarkMode_Explorer",p0)'
  SendMessage $FleetBrowseButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetBrowseButton FleetBrowse

  ${NSD_CreateCheckbox} 6% 71% 60% 6% "Create a desktop shortcut"
  Pop $FleetDesktopCheckbox
  SetCtlColors $FleetDesktopCheckbox ${FLEET_INK2} ${FLEET_BG}
  SendMessage $FleetDesktopCheckbox ${WM_SETFONT} $FleetFontBody 1
  System::Call 'UXTHEME::SetWindowTheme(p$FleetDesktopCheckbox,w"DarkMode_Explorer",p0)'
  ${NSD_Check} $FleetDesktopCheckbox

  ${NSD_CreateButton} 55% 87% 18% 8% "Cancel"
  Pop $FleetCancelButton
  System::Call 'UXTHEME::SetWindowTheme(p$FleetCancelButton,w"DarkMode_Explorer",p0)'
  SendMessage $FleetCancelButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetCancelButton FleetCancel

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 76% 87% 18% 8% "$FleetActionText"
  Pop $FleetInstallButton
  SetCtlColors $FleetInstallButton ${FLEET_ONACCENT} ${FLEET_ACCENT}
  SendMessage $FleetInstallButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetInstallButton FleetBeginInstall

  ${NSD_CreateTimer} FleetHoverPoll 60
  nsDialogs::Show
FunctionEnd


Function FleetBrowse
  Pop $0
  nsDialogs::SelectFolderDialog "Choose where Fleet is installed" "$INSTDIR"
  Pop $0
  ${If} $0 != error
    StrCpy $INSTDIR $0
    ${NSD_SetText} $FleetPathField "$INSTDIR"
  ${EndIf}
FunctionEnd

Function FleetCancel
  Pop $0
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

Function FleetBeginInstall
  Pop $0
  ; Route through the wizard's own command notification, the exact message the
  ; stock Next button emits (WM_COMMAND, id 1, BN_CLICKED). No detour through
  ; the hidden stock button's internal click state machine.
  GetDlgItem $R0 $HWNDPARENT 1
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 $R0
FunctionEnd

Function FleetInstallLeave
  ${NSD_GetText} $FleetPathField $0
  ${If} $0 == ""
    MessageBox MB_ICONEXCLAMATION "Choose an install location for Fleet."
    Abort
  ${EndIf}
  StrCpy $INSTDIR $0
  ${NSD_GetState} $FleetDesktopCheckbox $FleetDesktopShortcutState
FunctionEnd

; Hide the stock instfiles inner dialog. The NSIS core shows the page
; dialog again AFTER the page SHOW callback and once more when the install
; completes, so this is called from several points: page show, section
; start and .onInstSuccess.
Function FleetHideStockProgress
  ${If} $FleetProgressDialog != ""
  ${AndIf} $FleetProgressDialog != 0
    ShowWindow $FleetProgressDialog ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function FleetProgressShow
  Call FleetApplyWindowTheme
  Call FleetCreateFonts
  FindWindow $FleetProgressDialog "#32770" "" $HWNDPARENT
  ${If} $FleetProgressDialog == 0
    Return
  ${EndIf}

  ; ---- adopt the stock progress bar onto the wizard surface first ----
  ; NSIS keeps updating this exact control while the sections run, so the
  ; bar the user watches is the real one - reparented to the outer wizard
  ; dialog, restyled to the Fleet accent, in the install path field's slot.
  GetDlgItem $FleetProgressBar $FleetProgressDialog 1004
  ${If} $FleetProgressBar != 0
    System::Call 'USER32::SetParent(p$FleetProgressBar,p$HWNDPARENT)'
    System::Call 'USER32::GetWindowLong(p$FleetProgressBar,i-16)i.r0'
    IntOp $0 $0 | 1
    System::Call 'USER32::SetWindowLong(p$FleetProgressBar,i-16,ir0)'
    SendMessage $FleetProgressBar ${PBM_SETBARCOLOR} 0 ${FLEET_ACCENT}
    SendMessage $FleetProgressBar ${PBM_SETBKCOLOR} 0 ${FLEET_SURFACE3}
    System::Call 'USER32::GetClientRect(p$HWNDPARENT,@r0)'
    System::Call '*$0(i,i,i.r3,i.r4)'
    IntOp $R6 $3 * 6
    IntOp $R6 $R6 / 100
    IntOp $R7 $4 * 60
    IntOp $R7 $R7 / 100
    IntOp $R8 $3 * 88
    IntOp $R8 $R8 / 100
    IntOp $R9 $FleetDpi * 8
    IntOp $R9 $R9 / 96
    System::Call 'USER32::MoveWindow(p$FleetProgressBar,iR6,iR7,iR8,iR9,i1)'
    System::Call 'USER32::SetWindowPos(p$FleetProgressBar,p0,i0,i0,i0,i0,i0x0043)'
  ${EndIf}

  ; ---- hide the ENTIRE stock instfiles surface ----
  ; The white log panel (SysListView32), the "Show details" toggle, the
  ; banner labels and everything else on the inner dialog are replaced by
  ; Fleet's surface; the bar was just reparented out of it, so the whole
  ; inner dialog goes away in one move.
  Call FleetHideStockProgress

  ; ---- Fleet surface: plain Win32 statics on the wizard dialog ----
  ; nsDialogs must NOT be used on this built-in page: its canvas is only
  ; shown by nsDialogs::Show (which must never run inside a page SHOW
  ; callback), and its page-flow hook blocks the wizard's auto-advance
  ; after the sections finish - v1.5.4 froze on a blank progress page
  ; because of exactly that. Raw child statics of $HWNDPARENT keep the
  ; theme and leave the page flow completely stock, so the finish page
  ; appears by itself when the install completes.
  StrCpy $FleetHoverState 0
  StrCpy $FleetInstallButton ""
  StrCpy $FleetLaunchButton ""
  StrCpy $FleetMinimizeButton ""
  StrCpy $FleetTitleBar ""
  StrCpy $FleetLogo ""
  StrCpy $FleetTitleBarText ""
  StrCpy $FleetHairline ""
  StrCpy $FleetWindowCloseButton ""
  StrCpy $FleetVersionLabel ""
  StrCpy $FleetTitle ""
  StrCpy $FleetStatusText ""
  StrCpy $FleetProgressNote ""

  ; NOTE: $R5-$R9 are clobbered by FleetPlacePx, keep the title text in $R0
  ${If} $UpdateMode = 1
    StrCpy $R0 "Updating Fleet"
  ${Else}
    StrCpy $R0 "Installing Fleet"
  ${EndIf}

  ; titlebar wordmark
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"Fleet",i0x50000200,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetTitleBarText
  SendMessage $FleetTitleBarText ${WM_SETFONT} $FleetFontBrand 1
  SetCtlColors $FleetTitleBarText ${FLEET_TEXT} ${FLEET_BG}
  Push 56
  Push 0
  Push 260
  Push 44
  Push $FleetTitleBarText
  Call FleetPlacePx

  ; titlebar hairline
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetHairline
  SetCtlColors $FleetHairline ${FLEET_HAIR} ${FLEET_HAIR}
  Push 0
  Push 44
  Push 760
  Push 2
  Push $FleetHairline
  Call FleetPlacePx

  ; close glyph, control id 2: STATIC + SS_NOTIFY reports STN_CLICKED
  ; (== BN_CLICKED) through WM_COMMAND to the wizard = stock cancel flow
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"",i0x50000301,i0,i0,i0,i0,p$HWNDPARENT,p0,p2,p0,p0) p.s'
  Pop $FleetWindowCloseButton
  SendMessage $FleetWindowCloseButton ${WM_SETFONT} $FleetFontGlyph 1
  SetCtlColors $FleetWindowCloseButton ${FLEET_TEXT} ${FLEET_BG}
  Push 714
  Push 0
  Push 46
  Push 44
  Push $FleetWindowCloseButton
  Call FleetPlacePx

  ; eyebrow
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"FLEET ${VERSION}  ·   WINDOWS 10/11",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetVersionLabel
  SendMessage $FleetVersionLabel ${WM_SETFONT} $FleetFontSmall 1
  SetCtlColors $FleetVersionLabel ${FLEET_INK3} ${FLEET_BG}
  Push 46
  Push 59
  Push 532
  Push 27
  Push $FleetVersionLabel
  Call FleetPlacePx

  ; heading (Installing Fleet / Updating Fleet)
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetTitle
  SendMessage $FleetTitle ${WM_SETTEXT} 0 "STR:$R0"
  SendMessage $FleetTitle ${WM_SETFONT} $FleetFontTitle 1
  SetCtlColors $FleetTitle ${FLEET_TEXT} ${FLEET_BG}
  Push 46
  Push 92
  Push 669
  Push 49
  Push $FleetTitle
  Call FleetPlacePx

  ; live status line - FleetStatus (called from the sections) WM_SETTEXTs it
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"Preparing app files and the bundled runtime.",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetStatusText
  SendMessage $FleetStatusText ${WM_SETFONT} $FleetFontBody 1
  SetCtlColors $FleetStatusText ${FLEET_INK2} ${FLEET_BG}
  Push 46
  Push 146
  Push 669
  Push 32
  Push $FleetStatusText
  Call FleetPlacePx

  ; footer note
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"Keep using your PC - this window finishes by itself.",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetProgressNote
  SendMessage $FleetProgressNote ${WM_SETFONT} $FleetFontSmall 1
  SetCtlColors $FleetProgressNote ${FLEET_INK3} ${FLEET_BG}
  Push 46
  Push 383
  Push 669
  Push 27
  Push $FleetProgressNote
  Call FleetPlacePx
FunctionEnd

; Raw progress statics and the adopted bar are children of the wizard
; dialog, so they outlive the instfiles page - remove them when the wizard
; moves on to the finish page.
Function FleetDestroyProgressSurface
  ${If} $FleetTitleBarText != ""
  ${AndIf} $FleetTitleBarText != 0
    System::Call 'USER32::DestroyWindow(p$FleetTitleBarText)'
  ${EndIf}
  ${If} $FleetHairline != ""
  ${AndIf} $FleetHairline != 0
    System::Call 'USER32::DestroyWindow(p$FleetHairline)'
  ${EndIf}
  ${If} $FleetWindowCloseButton != ""
  ${AndIf} $FleetWindowCloseButton != 0
    System::Call 'USER32::DestroyWindow(p$FleetWindowCloseButton)'
  ${EndIf}
  ${If} $FleetVersionLabel != ""
  ${AndIf} $FleetVersionLabel != 0
    System::Call 'USER32::DestroyWindow(p$FleetVersionLabel)'
  ${EndIf}
  ${If} $FleetTitle != ""
  ${AndIf} $FleetTitle != 0
    System::Call 'USER32::DestroyWindow(p$FleetTitle)'
  ${EndIf}
  ${If} $FleetStatusText != ""
  ${AndIf} $FleetStatusText != 0
    System::Call 'USER32::DestroyWindow(p$FleetStatusText)'
  ${EndIf}
  ${If} $FleetProgressNote != ""
  ${AndIf} $FleetProgressNote != 0
    System::Call 'USER32::DestroyWindow(p$FleetProgressNote)'
  ${EndIf}
  ${If} $FleetProgressBar != ""
  ${AndIf} $FleetProgressBar != 0
    System::Call 'USER32::DestroyWindow(p$FleetProgressBar)'
  ${EndIf}
  StrCpy $FleetTitleBarText ""
  StrCpy $FleetHairline ""
  StrCpy $FleetWindowCloseButton ""
  StrCpy $FleetVersionLabel ""
  StrCpy $FleetTitle ""
  StrCpy $FleetStatusText ""
  StrCpy $FleetProgressNote ""
  StrCpy $FleetProgressBar ""
FunctionEnd

; Raw progress statics and the adopted bar are children of the wizard
; dialog, so they outlive the instfiles page - remove them when the wizard
; moves on to the finish page.


Function FleetFinishPage
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}

  Call FleetDestroyProgressSurface
  Call FleetApplyWindowTheme
  Call FleetCreateFonts
  ${If} $FleetDesktopShortcutState == ${BST_CHECKED}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  Call FleetPrepareFullCanvas
  nsDialogs::Create ${IDC_CHILDRECT}
  Pop $FleetFinishDialog
  ${If} $FleetFinishDialog == error
    Abort
  ${EndIf}
  SetCtlColors $FleetFinishDialog ${FLEET_TEXT} ${FLEET_BG}
  StrCpy $FleetHoverState 0
  StrCpy $FleetInstallButton ""
  StrCpy $FleetUninstallButton ""
  Call FleetCreateTitleBar

  ${NSD_CreateLabel} 6% 11% 70% 5% "FLEET ${VERSION}  ·  READY"
  Pop $FleetVersionLabel
  SetCtlColors $FleetVersionLabel ${FLEET_INK3} ${FLEET_BG}
  SendMessage $FleetVersionLabel ${WM_SETFONT} $FleetFontSmall 1

  ${NSD_CreateLabel} 6% 17% 88% 9% "Fleet is ready"
  Pop $FleetTitle
  SetCtlColors $FleetTitle ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetTitle ${WM_SETFONT} $FleetFontTitle 1

  ${NSD_CreateLabel} 6% 27% 88% 6% "Version ${VERSION} is installed for this Windows account."
  Pop $FleetSubtitle
  SetCtlColors $FleetSubtitle ${FLEET_INK2} ${FLEET_BG}
  SendMessage $FleetSubtitle ${WM_SETFONT} $FleetFontBody 1

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 6% 34% 88% 13% "INSTALLED TO   ·   $INSTDIR"
  Pop $FleetFeatureBand
  SetCtlColors $FleetFeatureBand ${FLEET_INK2} ${FLEET_SURFACE}
  SendMessage $FleetFeatureBand ${WM_SETFONT} $FleetFontSmall 1

  ${NSD_CreateButton} 55% 87% 18% 8% "Close"
  Pop $FleetCloseButton
  System::Call 'UXTHEME::SetWindowTheme(p$FleetCloseButton,w"DarkMode_Explorer",p0)'
  SendMessage $FleetCloseButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetCloseButton FleetClose

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 76% 87% 18% 8% "Launch Fleet"
  Pop $FleetLaunchButton
  SetCtlColors $FleetLaunchButton ${FLEET_ONACCENT} ${FLEET_ACCENT}
  SendMessage $FleetLaunchButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetLaunchButton FleetLaunch

  ${NSD_CreateTimer} FleetHoverPoll 60
  nsDialogs::Show
FunctionEnd


Function FleetLaunch
  Pop $0
  Call RunMainBinary
  Quit
FunctionEnd

Function FleetClose
  Pop $0
  Quit
FunctionEnd

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Fleet confirm page (custom nsDialogs surface)
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
UninstPage custom un.FleetConfirmPage un.FleetConfirmPageLeave
; Uninstaller surfaces. Same Fleet chrome: frameless dark window, MDL2
; caption glyphs, hover states, one confirm page, one dark progress page.

Function un.FleetApplyWindowTheme
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i20,*i1,i4)i.r0'
  ${If} $0 != 0
    System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i19,*i1,i4)i.r0'
  ${EndIf}
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i33,*i2,i4)i.r0'

  ${NSD_RemoveStyle} $HWNDPARENT 0x00C40000
  ${NSD_RemoveStyle} $HWNDPARENT 0x00010000
  ${NSD_AddStyle} $HWNDPARENT 0x000A0000

  System::Call 'USER32::GetDpiForWindow(p$HWNDPARENT)i.r0'
  ${If} $0 = 0
  ${OrIf} $0 == error
    StrCpy $0 96
  ${EndIf}
  StrCpy $FleetDpi $0

  IntOp $1 $0 * 560
  IntOp $1 $1 / 96
  IntOp $2 $0 * 400
  IntOp $2 $2 / 96
  System::Call 'USER32::GetSystemMetrics(i0)i.r3'
  System::Call 'USER32::GetSystemMetrics(i1)i.r4'
  IntOp $3 $3 - $1
  IntOp $3 $3 / 2
  IntOp $4 $4 - $2
  IntOp $4 $4 / 2
  System::Call 'USER32::SetWindowPos(p$HWNDPARENT,p0,ir3,ir4,ir1,ir2,i0x0024)'

  SetCtlColors $HWNDPARENT ${FLEET_TEXT} ${FLEET_BG}
  !insertmacro FleetHideWizardChrome
FunctionEnd

Function un.FleetCreateFonts
  ${If} $FleetFontTitle == ""
    CreateFont $FleetFontBrand "Segoe UI" 10 600
    CreateFont $FleetFontTitle "Segoe UI" 15 700
    CreateFont $FleetFontBody "Segoe UI" 9 400
    CreateFont $FleetFontSmall "Segoe UI" 7 600
    CreateFont $FleetFontButton "Segoe UI" 9 600
    CreateFont $FleetFontGlyph "Segoe MDL2 Assets" 10 400
  ${EndIf}
FunctionEnd

Function un.FleetPlacePx
  Pop $R5
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  ${If} $FleetDpi != 96
    IntOp $R6 $R6 * $FleetDpi
    IntOp $R6 $R6 / 96
    IntOp $R7 $R7 * $FleetDpi
    IntOp $R7 $R7 / 96
    IntOp $R8 $R8 * $FleetDpi
    IntOp $R8 $R8 / 96
    IntOp $R9 $R9 * $FleetDpi
    IntOp $R9 $R9 / 96
  ${EndIf}
  System::Call 'USER32::MoveWindow(p$R5,i$R6,i$R7,i$R8,i$R9,i1)'
FunctionEnd

Function un.FleetCreateTitleBar
  ${NSD_CreateLabel} 0 0 100% 11% ""
  Pop $FleetTitleBar
  SetCtlColors $FleetTitleBar ${FLEET_TEXT} ${FLEET_BG}
  ${NSD_OnClick} $FleetTitleBar un.FleetDragWindow

  ${NSD_CreateIcon} 2% 2.6% 6% 7.5% ""
  Pop $FleetLogo
  !if "${UNINSTALLERICON}" != ""
    ${NSD_SetIcon} $FleetLogo "${UNINSTALLERICON}" $FleetLogoImage
  !else
    ${NSD_SetIconFromInstaller} $FleetLogo $FleetLogoImage
  !endif

  ${NSD_CreateLabel} 11% 0 70% 11% "Fleet"
  Pop $FleetTitleBarText
  SetCtlColors $FleetTitleBarText ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetTitleBarText ${WM_SETFONT} $FleetFontBrand 1

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 84% 0 8% 11% ""
  Pop $FleetMinimizeButton
  SetCtlColors $FleetMinimizeButton ${FLEET_INK2} ${FLEET_BG}
  SendMessage $FleetMinimizeButton ${WM_SETFONT} $FleetFontGlyph 1
  ${NSD_OnClick} $FleetMinimizeButton un.FleetMinimize

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 92% 0 8% 11% ""
  Pop $FleetWindowCloseButton
  SetCtlColors $FleetWindowCloseButton ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetWindowCloseButton ${WM_SETFONT} $FleetFontGlyph 1
  ${NSD_OnClick} $FleetWindowCloseButton un.FleetCancel

  Push 16
  Push 7
  Push 30
  Push 30
  Push $FleetLogo
  Call un.FleetPlacePx
  Push 56
  Push 0
  Push 260
  Push 48
  Push $FleetTitleBarText
  Call un.FleetPlacePx

  System::Call 'USER32::GetClientRect(p$HWNDPARENT,@r0)'
  System::Call '*$0(i,i,i.r1,i.r2)'
  IntOp $R4 $FleetDpi * 46
  IntOp $R4 $R4 / 96
  IntOp $R5 $FleetDpi * 48
  IntOp $R5 $R5 / 96
  IntOp $R6 $1 - $R4
  IntOp $R6 $R6 - $R4
  IntOp $R7 $1 - $R4
  System::Call 'USER32::MoveWindow(p$FleetMinimizeButton,iR6,i0,iR4,iR5,i1)'
  System::Call 'USER32::MoveWindow(p$FleetWindowCloseButton,iR7,i0,iR4,iR5,i1)'

  ${NSD_CreateLabel} 0 11% 100% 1u ""
  Pop $FleetHairline
  SetCtlColors $FleetHairline ${FLEET_HAIR} ${FLEET_HAIR}

  System::Call 'USER32::SetWindowPos(p$FleetTitleBar,p1,i0,i0,i0,i0,i0x0013)'
FunctionEnd

Function un.FleetHoverPoll
  System::Call 'USER32::GetCursorPos(@r5)'
  System::Call '*$5(i.r1,i.r2)'
  StrCpy $R0 0

  ${If} $FleetMinimizeButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetMinimizeButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 1
    ${EndIf}
  ${EndIf}

  ${If} $FleetWindowCloseButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetWindowCloseButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 2
    ${EndIf}
  ${EndIf}

  ${If} $FleetUninstallButton != ""
    System::Call 'USER32::GetWindowRect(p$FleetUninstallButton,@r6)'
    System::Call '*$6(i.r3,i.r4,i.r7,i.r8)'
    ${If} $1 >= $3
    ${AndIf} $1 < $R7
    ${AndIf} $2 >= $4
    ${AndIf} $2 < $R8
      IntOp $R0 $R0 | 4
    ${EndIf}
  ${EndIf}

  ${If} $R0 != $FleetHoverState
    StrCpy $FleetHoverState $R0

    IntOp $R1 $R0 & 1
    ${If} $R1 <> 0
      SetCtlColors $FleetMinimizeButton ${FLEET_TEXT} ${FLEET_SURFACE2}
    ${Else}
      SetCtlColors $FleetMinimizeButton ${FLEET_INK2} ${FLEET_BG}
    ${EndIf}
    System::Call 'USER32::InvalidateRect(p$FleetMinimizeButton,p0,i1)'

    IntOp $R1 $R0 & 2
    ${If} $R1 <> 0
      SetCtlColors $FleetWindowCloseButton ${FLEET_ONACCENT} ${FLEET_DANGER}
    ${Else}
      SetCtlColors $FleetWindowCloseButton ${FLEET_TEXT} ${FLEET_BG}
    ${EndIf}
    System::Call 'USER32::InvalidateRect(p$FleetWindowCloseButton,p0,i1)'

    IntOp $R1 $R0 & 4
    ${If} $R1 <> 0
      SetCtlColors $FleetUninstallButton ${FLEET_ONACCENT} ${FLEET_DANGER2}
    ${Else}
      SetCtlColors $FleetUninstallButton ${FLEET_ONACCENT} ${FLEET_DANGER}
    ${EndIf}
    System::Call 'USER32::InvalidateRect(p$FleetUninstallButton,p0,i1)'
  ${EndIf}
FunctionEnd

Function un.FleetDragWindow
  Pop $0
  System::Call 'USER32::ReleaseCapture()'
  SendMessage $HWNDPARENT ${WM_NCLBUTTONDOWN} ${HTCAPTION} 0
FunctionEnd

Function un.FleetMinimize
  Pop $0
  ShowWindow $HWNDPARENT 6
FunctionEnd

Function un.FleetCancel
  Pop $0
  GetDlgItem $0 $HWNDPARENT 2
  SendMessage $0 ${BM_CLICK} 0 0
FunctionEnd

Function un.FleetGuiInit
  Call un.FleetApplyWindowTheme
FunctionEnd

; The confirm page: Fleet chrome, a plain-language explanation, the
; app-data choice, and Uninstall/Cancel in Fleet styling.
Function un.FleetConfirmPage
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}

  Call un.FleetApplyWindowTheme
  Call un.FleetCreateFonts
  nsDialogs::Create /NOUNLOAD ${IDC_CHILDRECT}
  Pop $FleetDialog
  ${If} $FleetDialog == error
    Abort
  ${EndIf}
  SetCtlColors $FleetDialog ${FLEET_TEXT} ${FLEET_BG}
  StrCpy $FleetHoverState 0
  StrCpy $FleetInstallButton ""
  StrCpy $FleetLaunchButton ""
  Call un.FleetCreateTitleBar

  ${NSD_CreateLabel} 6% 18% 88% 9% "Uninstall Fleet"
  Pop $FleetTitle
  SetCtlColors $FleetTitle ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetTitle ${WM_SETFONT} $FleetFontTitle 1

  ${NSD_CreateLabel} 6% 29% 88% 9% "This removes Fleet, its shortcuts and the bundled runtime from this Windows account."
  Pop $FleetSubtitle
  SetCtlColors $FleetSubtitle ${FLEET_INK2} ${FLEET_BG}
  SendMessage $FleetSubtitle ${WM_SETFONT} $FleetFontBody 1

  ${NSD_CreateCheckbox} 6% 43% 80% 7% "Also delete Fleet app data (instances, accounts and settings)"
  Pop $DeleteAppDataCheckbox
  SetCtlColors $DeleteAppDataCheckbox ${FLEET_INK2} ${FLEET_BG}
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $FleetFontBody 1
  System::Call 'UXTHEME::SetWindowTheme(p$DeleteAppDataCheckbox,w"DarkMode_Explorer",p0)'

  ${NSD_CreateButton} 55% 84% 18% 9% "Cancel"
  Pop $FleetCancelButton
  System::Call 'UXTHEME::SetWindowTheme(p$FleetCancelButton,w"DarkMode_Explorer",p0)'
  SendMessage $FleetCancelButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetCancelButton un.FleetCancel

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 76% 84% 18% 9% "Uninstall"
  Pop $FleetUninstallButton
  SetCtlColors $FleetUninstallButton ${FLEET_ONACCENT} ${FLEET_DANGER}
  SendMessage $FleetUninstallButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetUninstallButton un.FleetBeginUninstall

  ${NSD_CreateTimer} un.FleetHoverPoll 60
  nsDialogs::Show
FunctionEnd

Function un.FleetBeginUninstall
  Pop $0
  ; the wizard's own Next notification: WM_COMMAND, id 1, BN_CLICKED
  GetDlgItem $R0 $HWNDPARENT 1
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 $R0
FunctionEnd

Function un.FleetStatus
  Pop $R0
  ${If} $FleetStatusText != ""
  ${AndIf} $FleetStatusText != error
  ${AndIf} $FleetStatusText != 0
    SendMessage $FleetStatusText ${WM_SETTEXT} 0 "STR:$R0"
  ${EndIf}
FunctionEnd

Function un.FleetConfirmPageLeave
  ${If} $DeleteAppDataCheckbox != ""
    SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
  ${EndIf}
FunctionEnd

; Dark progress surface for the removal itself.
; Uninstaller twin of FleetHideStockProgress.
Function un.FleetHideStockProgress
  ${If} $FleetProgressDialog != ""
  ${AndIf} $FleetProgressDialog != 0
    ShowWindow $FleetProgressDialog ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function un.InstFilesShow
  Call un.FleetApplyWindowTheme
  Call un.FleetCreateFonts
  FindWindow $FleetProgressDialog "#32770" "" $HWNDPARENT
  ${If} $FleetProgressDialog == 0
    Return
  ${EndIf}

  ; ---- adopt the stock progress bar onto the wizard surface first ----
  GetDlgItem $FleetProgressBar $FleetProgressDialog 1004
  ${If} $FleetProgressBar != 0
    System::Call 'USER32::SetParent(p$FleetProgressBar,p$HWNDPARENT)'
    System::Call 'USER32::GetWindowLong(p$FleetProgressBar,i-16)i.r0'
    IntOp $0 $0 | 1
    System::Call 'USER32::SetWindowLong(p$FleetProgressBar,i-16,ir0)'
    SendMessage $FleetProgressBar ${PBM_SETBARCOLOR} 0 ${FLEET_ACCENT}
    SendMessage $FleetProgressBar ${PBM_SETBKCOLOR} 0 ${FLEET_SURFACE3}
    System::Call 'USER32::GetClientRect(p$HWNDPARENT,@r0)'
    System::Call '*$0(i,i,i.r3,i.r4)'
    IntOp $R6 $3 * 6
    IntOp $R6 $R6 / 100
    IntOp $R7 $4 * 60
    IntOp $R7 $R7 / 100
    IntOp $R8 $3 * 88
    IntOp $R8 $R8 / 100
    IntOp $R9 $FleetDpi * 8
    IntOp $R9 $R9 / 96
    System::Call 'USER32::MoveWindow(p$FleetProgressBar,iR6,iR7,iR8,iR9,i1)'
    System::Call 'USER32::SetWindowPos(p$FleetProgressBar,p0,i0,i0,i0,i0,i0x0043)'
  ${EndIf}

  ; ---- hide the ENTIRE stock uninstall instfiles surface ----
  Call un.FleetHideStockProgress

  ; ---- Fleet surface: plain Win32 statics on the wizard dialog ----
  ; (same rationale as the installer's progress page: nsDialogs canvases
  ; never render on built-in pages and break the page flow)
  StrCpy $FleetHoverState 0
  StrCpy $FleetInstallButton ""
  StrCpy $FleetLaunchButton ""
  StrCpy $FleetUninstallButton ""
  StrCpy $FleetMinimizeButton ""
  StrCpy $FleetTitleBar ""
  StrCpy $FleetLogo ""
  StrCpy $FleetTitleBarText ""
  StrCpy $FleetHairline ""
  StrCpy $FleetWindowCloseButton ""
  StrCpy $FleetVersionLabel ""
  StrCpy $FleetTitle ""
  StrCpy $FleetStatusText ""
  StrCpy $FleetProgressNote ""

  ; titlebar wordmark
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"Fleet",i0x50000200,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetTitleBarText
  SendMessage $FleetTitleBarText ${WM_SETFONT} $FleetFontBrand 1
  SetCtlColors $FleetTitleBarText ${FLEET_TEXT} ${FLEET_BG}
  Push 56
  Push 0
  Push 260
  Push 44
  Push $FleetTitleBarText
  Call un.FleetPlacePx

  ; titlebar hairline
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetHairline
  SetCtlColors $FleetHairline ${FLEET_HAIR} ${FLEET_HAIR}
  Push 0
  Push 44
  Push 760
  Push 2
  Push $FleetHairline
  Call un.FleetPlacePx

  ; close glyph, control id 2 -> stock uninstall cancel flow
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"",i0x50000301,i0,i0,i0,i0,p$HWNDPARENT,p0,p2,p0,p0) p.s'
  Pop $FleetWindowCloseButton
  SendMessage $FleetWindowCloseButton ${WM_SETFONT} $FleetFontGlyph 1
  SetCtlColors $FleetWindowCloseButton ${FLEET_TEXT} ${FLEET_BG}
  Push 714
  Push 0
  Push 46
  Push 44
  Push $FleetWindowCloseButton
  Call un.FleetPlacePx

  ; eyebrow
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"FLEET ${VERSION}  ·   REMOVING",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetVersionLabel
  SendMessage $FleetVersionLabel ${WM_SETFONT} $FleetFontSmall 1
  SetCtlColors $FleetVersionLabel ${FLEET_INK3} ${FLEET_BG}
  Push 46
  Push 130
  Push 532
  Push 27
  Push $FleetVersionLabel
  Call un.FleetPlacePx

  ; heading
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"Uninstalling Fleet",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetTitle
  SendMessage $FleetTitle ${WM_SETFONT} $FleetFontTitle 1
  SetCtlColors $FleetTitle ${FLEET_TEXT} ${FLEET_BG}
  Push 46
  Push 178
  Push 669
  Push 49
  Push $FleetTitle
  Call un.FleetPlacePx

  ; live status line - un.FleetStatus WM_SETTEXTs it
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"Removing files, shortcuts and registry entries.",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetStatusText
  SendMessage $FleetStatusText ${WM_SETFONT} $FleetFontBody 1
  SetCtlColors $FleetStatusText ${FLEET_INK2} ${FLEET_BG}
  Push 46
  Push 265
  Push 669
  Push 32
  Push $FleetStatusText
  Call un.FleetPlacePx

  ; footer note
  System::Call 'USER32::CreateWindowExW(i0,w"STATIC",w"This window closes by itself when removal finishes.",i0x50000000,i0,i0,i0,i0,p$HWNDPARENT,p0,p0,p0,p0) p.s'
  Pop $FleetProgressNote
  SendMessage $FleetProgressNote ${WM_SETFONT} $FleetFontSmall 1
  SetCtlColors $FleetProgressNote ${FLEET_INK3} ${FLEET_BG}
  Push 46
  Push 421
  Push 669
  Push 27
  Push $FleetProgressNote
  Call un.FleetPlacePx
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.InstFilesShow
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext

  ${If} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    !if "${INSTALLMODE}" == "perMachine"
      ${If} ${RunningX64}
        !if "${ARCH}" == "x64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else if "${ARCH}" == "arm64"
          StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
        !else
          StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
        !endif
      ${Else}
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      ${EndIf}
    !else if "${INSTALLMODE}" == "currentUser"
      StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
    !endif

    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd


Section EarlyChecks
  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $R0 = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  Push "Checking the WebView2 runtime..."
  Call FleetStatus
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        Push "Installing the WebView2 runtime (this can take a minute)..."
        Call FleetStatus
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR
  Push "Copying Fleet files..."
  Call FleetStatus
  Call FleetHideStockProgress
  

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}

  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
       !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" "{{association-description association.description ext}}" "$INSTDIR\${MAINBINARYNAME}.exe,0" "Open with ${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe $\"%1$\""
    {{/each}}
  {{/each}}

  ; Register deep links
  {{#each deep_link_protocols as |protocol| ~}}
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "URL Protocol" ""
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}" "" "URL:${BUNDLEID} protocol"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
    WriteRegStr SHCTX "Software\Classes\\{{protocol}}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  {{/each}}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  Push "Creating shortcuts..."
  Call FleetStatus
  
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; Fleet has no visible stock Next button, and the NSIS page manager only
  ; walks from the PWP_COMPLETED pseudo-page into the finish page when
  ; autoclose is set - it reads the flag on page entry, so it must be set
  ; before the sections end, not from .onInstSuccess (too late).
  SetAutoClose true
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${Else}
    ; NSIS parks the wizard on the PWP_COMPLETED pseudo-page after the
    ; sections finish (Ui.c: "PWP_COMPLETED always follows PWP_INSTFILES")
    ; and only advances to the next page when autoclose is set - otherwise
    ; it waits for a click on the stock Next button, which Fleet's chrome
    ; hides. That is the actual "installer just sits there" bug since the
    ; custom chrome shipped. SetAutoClose makes the page manager walk
    ; straight into FleetFinishPage; the stock log panel it would show in
    ; between gets hidden again first.
    Call FleetHideStockProgress
    SetAutoClose true
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall
  Call un.FleetHideStockProgress

  Push "Closing Fleet and removing app files..."
  Call un.FleetStatus

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
  {{#each resources}}
    Delete "$INSTDIR\\{{this.[1]}}"
  {{/each}}

  ; Delete external binaries
  {{#each binaries}}
    Delete "$INSTDIR\\{{this}}"
  {{/each}}

  ; Delete app associations
  {{#each file_associations as |association| ~}}
    {{#each association.ext as |ext| ~}}
      !insertmacro APP_UNASSOCIATE "{{ext}}" "{{or association.name ext}}"
    {{/each}}
  {{/each}}

  ; Delete deep links
  {{#each deep_link_protocols as |protocol| ~}}
    ReadRegStr $R7 SHCTX "Software\Classes\\{{protocol}}\shell\open\command" ""
    ${If} $R7 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
      DeleteRegKey SHCTX "Software\Classes\\{{protocol}}"
    ${EndIf}
  {{/each}}


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  {{#each resources_ancestors}}
  RMDir /REBOOTOK "$INSTDIR\\{{this}}"
  {{/each}}
  RMDir "$INSTDIR"

  Push "Removing shortcuts and registry entries..."
  Call un.FleetStatus

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
