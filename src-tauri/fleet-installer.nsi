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
!define FLEET_BG 0x08090B
!define FLEET_SURFACE 0x111217
!define FLEET_SURFACE_RAISED 0x191B22
!define FLEET_TEXT 0xF8FBFF
!define FLEET_MUTED 0x969AA6
!define FLEET_BLUE 0x2F6DF2
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
Var FleetBrand
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
  StrCpy $UpdateMode 1
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

Function FleetApplyWindowTheme
  ; Fleet owns the whole window. Keep Windows 11's smooth DWM corners while
  ; removing the native NSIS caption and resize frame.
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i20,*i1,i4)i.r0'
  ${If} $0 != 0
    System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i19,*i1,i4)i.r0'
  ${EndIf}
  System::Call 'DWMAPI::DwmSetWindowAttribute(p$HWNDPARENT,i33,*i2,i4)i.r0'
  ${NSD_RemoveStyle} $HWNDPARENT 0x00C40000

  ; NSIS keeps a compact legacy window by default. Give Fleet a roomy canvas.
  System::Call 'USER32::GetSystemMetrics(i0)i.r0'
  System::Call 'USER32::GetSystemMetrics(i1)i.r1'
  IntOp $0 $0 - 760
  IntOp $0 $0 / 2
  IntOp $1 $1 - 540
  IntOp $1 $1 / 2
  System::Call 'USER32::SetWindowPos(p$HWNDPARENT,p0,ir0,ir1,i760,i540,i0x0024)'

  ; Remove the stock wizard navigation. Every action lives inside Fleet's surface.
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1037
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1038
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

Function FleetPrepareFullCanvas
  ; MUI normally reserves a header and white navigation footer. Expand the
  ; custom-page reference rectangle over the complete client area instead.
  System::Call 'USER32::GetClientRect(p$HWNDPARENT,@r0)'
  System::Call '*$0(i,i,i.r3,i.r4)'
  GetDlgItem $0 $HWNDPARENT ${IDC_CHILDRECT}
  ${If} $0 != 0
    System::Call 'USER32::MoveWindow(pr0,i0,i0,ir3,ir4,i0)'
  ${EndIf}
FunctionEnd

Function FleetCreateFonts
  CreateFont $FleetFontBrand "Segoe UI" 10 600
  CreateFont $FleetFontTitle "Segoe UI" 16 700
  CreateFont $FleetFontBody "Segoe UI" 9 400
  CreateFont $FleetFontSmall "Segoe UI" 7 600
  CreateFont $FleetFontButton "Segoe UI" 9 600
FunctionEnd

Function FleetStyleLabel
  Pop $0
  SetCtlColors $0 ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $0 ${WM_SETFONT} $FleetFontBody 1
FunctionEnd

Function FleetCreateTitleBar
  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTERIMAGE}" 0 0 0 100% 14% ""
  Pop $FleetTitleBar
  SetCtlColors $FleetTitleBar ${FLEET_TEXT} ${FLEET_SURFACE}
  ${NSD_OnClick} $FleetTitleBar FleetDragWindow

  ${NSD_CreateIcon} 3% 2% 6% 7% ""
  Pop $FleetLogo
  !if "${INSTALLERICON}" != ""
    ${NSD_SetIcon} $FleetLogo "${INSTALLERICON}" $FleetLogoImage
  !else
    ${NSD_SetIconFromInstaller} $FleetLogo $FleetLogoImage
  !endif

  ${NSD_CreateLabel} 13% 1% 49% 11% "Fleet Installer"
  Pop $FleetTitleBarText
  SetCtlColors $FleetTitleBarText ${FLEET_TEXT} ${FLEET_SURFACE}
  SendMessage $FleetTitleBarText ${WM_SETFONT} $FleetFontBrand 1

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 84% 0 8% 14% "-"
  Pop $FleetMinimizeButton
  SetCtlColors $FleetMinimizeButton ${FLEET_MUTED} ${FLEET_SURFACE}
  SendMessage $FleetMinimizeButton ${WM_SETFONT} $FleetFontBrand 1
  ${NSD_OnClick} $FleetMinimizeButton FleetMinimize

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 92% 0 8% 14% "X"
  Pop $FleetWindowCloseButton
  SetCtlColors $FleetWindowCloseButton ${FLEET_TEXT} ${FLEET_SURFACE}
  SendMessage $FleetWindowCloseButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetWindowCloseButton FleetCancel

  ; Static controls created by nsDialogs can otherwise land behind the full
  ; title-bar fill. Pin that fill to the bottom of the sibling Z-order.
  System::Call 'USER32::SetWindowPos(p$FleetTitleBar,p1,i0,i0,i0,i0,i0x0013)'
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

Function FleetInstallPage
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} ${Silent}
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
  Call FleetCreateTitleBar

  ${NSD_CreateLabel} 6% 16% 70% 5% "FLEET ${VERSION}  -  WINDOWS 10/11"
  Pop $FleetVersionLabel
  SetCtlColors $FleetVersionLabel ${FLEET_MUTED} ${FLEET_BG}
  SendMessage $FleetVersionLabel ${WM_SETFONT} $FleetFontSmall 1

  ${If} $UpdateMode = 1
    StrCpy $FleetActionText "Update Fleet"
  ${Else}
    StrCpy $FleetActionText "Install Fleet"
  ${EndIf}

  ${NSD_CreateLabel} 6% 22% 88% 10% "$FleetActionText"
  Pop $FleetTitle
  SetCtlColors $FleetTitle ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetTitle ${WM_SETFONT} $FleetFontTitle 1

  ${NSD_CreateLabel} 6% 33% 88% 6% "One command center for every Roblox client."
  Pop $FleetSubtitle
  Push $FleetSubtitle
  Call FleetStyleLabel

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 6% 43% 88% 12% "MULTI-INSTANCE    -    LOCAL-FIRST    -    OPEN SOURCE"
  Pop $FleetFeatureBand
  SetCtlColors $FleetFeatureBand ${FLEET_MUTED} ${FLEET_SURFACE}
  SendMessage $FleetFeatureBand ${WM_SETFONT} $FleetFontSmall 1

  ${NSD_CreateLabel} 6% 61% 88% 5% "INSTALL LOCATION"
  Pop $FleetPathLabel
  SetCtlColors $FleetPathLabel ${FLEET_MUTED} ${FLEET_BG}
  SendMessage $FleetPathLabel ${WM_SETFONT} $FleetFontSmall 1

  ${NSD_CreateDirRequest} 6% 67% 68% 9% "$INSTDIR"
  Pop $FleetPathField
  SetCtlColors $FleetPathField ${FLEET_TEXT} ${FLEET_SURFACE}
  System::Call 'UXTHEME::SetWindowTheme(p$FleetPathField,w"DarkMode_Explorer",p0)'

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 76% 67% 18% 9% "Browse"
  Pop $FleetBrowseButton
  SetCtlColors $FleetBrowseButton ${FLEET_TEXT} ${FLEET_SURFACE_RAISED}
  SendMessage $FleetBrowseButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetBrowseButton FleetBrowse

  ${NSD_CreateCheckbox} 6% 81% 43% 6% "Create a desktop shortcut"
  Pop $FleetDesktopCheckbox
  SetCtlColors $FleetDesktopCheckbox ${FLEET_MUTED} ${FLEET_BG}
  SendMessage $FleetDesktopCheckbox ${WM_SETFONT} $FleetFontBody 1
  System::Call 'UXTHEME::SetWindowTheme(p$FleetDesktopCheckbox,w"",w"")'
  ${NSD_Check} $FleetDesktopCheckbox

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 52% 87% 18% 9% "Cancel"
  Pop $FleetCancelButton
  SetCtlColors $FleetCancelButton ${FLEET_TEXT} ${FLEET_SURFACE_RAISED}
  SendMessage $FleetCancelButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetCancelButton FleetCancel

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 73% 87% 21% 9% "$FleetActionText"
  Pop $FleetInstallButton
  SetCtlColors $FleetInstallButton 0xFFFFFF ${FLEET_BLUE}
  SendMessage $FleetInstallButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetInstallButton FleetBeginInstall

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
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${BM_CLICK} 0 0
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

Function FleetProgressShow
  Call FleetApplyWindowTheme
  Call FleetCreateFonts
  !insertmacro MUI_HEADER_TEXT "Installing Fleet" "Preparing app files and the local runtime."
  FindWindow $FleetProgressDialog "#32770" "" $HWNDPARENT
  ${If} $FleetProgressDialog != 0
    System::Call 'USER32::GetClientRect(p$HWNDPARENT,@r0)'
    System::Call '*$0(i,i,i.r3,i.r4)'
    System::Call 'USER32::MoveWindow(p$FleetProgressDialog,i0,i0,ir3,ir4,i1)'
    SetCtlColors $FleetProgressDialog ${FLEET_TEXT} ${FLEET_BG}
    GetDlgItem $0 $FleetProgressDialog 1006
    SetCtlColors $0 ${FLEET_TEXT} ${FLEET_BG}
    SendMessage $0 ${WM_SETFONT} $FleetFontBody 1
    GetDlgItem $0 $FleetProgressDialog 1027
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $FleetProgressDialog 1016
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $FleetProgressBar $FleetProgressDialog 1004
    ${If} $FleetProgressBar != 0
      SendMessage $FleetProgressBar ${PBM_SETBARCOLOR} 0 0x00F26D2F
      SendMessage $FleetProgressBar ${PBM_SETBKCOLOR} 0 0x002B2220
    ${EndIf}
  ${EndIf}
FunctionEnd

Function FleetFinishPage
  ${If} $PassiveMode = 1
    Abort
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}

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
  Call FleetCreateTitleBar

  ${NSD_CreateLabel} 6% 16% 70% 5% "FLEET ${VERSION}  -  READY"
  Pop $FleetVersionLabel
  SetCtlColors $FleetVersionLabel ${FLEET_MUTED} ${FLEET_BG}
  SendMessage $FleetVersionLabel ${WM_SETFONT} $FleetFontSmall 1

  ${NSD_CreateLabel} 6% 28% 88% 11% "Fleet is ready"
  Pop $FleetTitle
  SetCtlColors $FleetTitle ${FLEET_TEXT} ${FLEET_BG}
  SendMessage $FleetTitle ${WM_SETFONT} $FleetFontTitle 1

  ${NSD_CreateLabel} 6% 42% 88% 8% "Version ${VERSION} is installed for this Windows account."
  Pop $FleetSubtitle
  Push $FleetSubtitle
  Call FleetStyleLabel

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 6% 56% 88% 14% "INSTALLED TO    $INSTDIR"
  Pop $FleetFeatureBand
  SetCtlColors $FleetFeatureBand ${FLEET_MUTED} ${FLEET_SURFACE}
  SendMessage $FleetFeatureBand ${WM_SETFONT} $FleetFontSmall 1

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 55% 85% 18% 10% "Close"
  Pop $FleetCloseButton
  SetCtlColors $FleetCloseButton ${FLEET_TEXT} ${FLEET_SURFACE_RAISED}
  SendMessage $FleetCloseButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetCloseButton FleetClose

  nsDialogs::CreateControl STATIC "${DEFAULT_STYLES}|${SS_NOTIFY}|${SS_CENTER}|${SS_CENTERIMAGE}" 0 76% 85% 18% 10% "Launch Fleet"
  Pop $FleetLaunchButton
  SetCtlColors $FleetLaunchButton 0xFFFFFF ${FLEET_BLUE}
  SendMessage $FleetLaunchButton ${WM_SETFONT} $FleetFontButton 1
  ${NSD_OnClick} $FleetLaunchButton FleetLaunch

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
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
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

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
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

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
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
