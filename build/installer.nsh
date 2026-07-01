; Fleet custom installer UI — minimalist, black/white, no marketing copy.
; Shows "Update detected" when Fleet is already installed, otherwise a first-run
; welcome. The wizard is stripped to: welcome -> progress -> finish (runs Fleet).
; (electron-updater runs this silently with /S for background updates, so this UI
;  is only seen on a manual install.)

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!macro customHeader
  !define MUI_ABORTWARNING
  BrandingText "Fleet"
!macroend

; Replace the default MUI welcome page with a custom, text-driven one.
!macro customWelcomePage
  Page custom FleetWelcomeShow
!macroend

; The uninstaller compiles in a separate makensis pass (BUILD_UNINSTALLER),
; where this page is never inserted — guard it so it isn't flagged unreferenced.
!ifndef BUILD_UNINSTALLER
Var FleetDlg
Var FleetHeading
Var FleetSub
Var FleetHeadFont
Var FleetSubFont
Var FleetIsUpdate

Function FleetWelcomeShow
  ; Detect an existing install: electron-builder resolves $INSTDIR to the prior
  ; location during .onInit, so the app exe already being there means "update".
  StrCpy $FleetIsUpdate "0"
  ${If} ${FileExists} "$INSTDIR\Fleet.exe"
    StrCpy $FleetIsUpdate "1"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $FleetDlg
  ${If} $FleetDlg == error
    Abort
  ${EndIf}
  SetCtlColors $FleetDlg 0x101114 0xFFFFFF

  CreateFont $FleetHeadFont "Segoe UI Semibold" "30" "600"
  CreateFont $FleetSubFont  "Segoe UI"          "11" "400"

  ${NSD_CreateLabel} 0 74u 100% 22u ""
  Pop $FleetHeading
  ${NSD_AddStyle} $FleetHeading 0x00000001 ; SS_CENTER
  SetCtlColors $FleetHeading 0x101114 0xFFFFFF
  SendMessage $FleetHeading ${WM_SETFONT} $FleetHeadFont 1

  ${NSD_CreateLabel} 0 104u 100% 14u ""
  Pop $FleetSub
  ${NSD_AddStyle} $FleetSub 0x00000001 ; SS_CENTER
  SetCtlColors $FleetSub 0x8A8F98 0xFFFFFF
  SendMessage $FleetSub ${WM_SETFONT} $FleetSubFont 1

  ${If} $FleetIsUpdate == "1"
    ${NSD_SetText} $FleetHeading "Update detected"
    ${NSD_SetText} $FleetSub "Updating Fleet to the latest version"
  ${Else}
    ${NSD_SetText} $FleetHeading "Welcome to Fleet"
    ${NSD_SetText} $FleetSub "Setting Fleet up on your PC"
  ${EndIf}

  nsDialogs::Show
FunctionEnd
!endif ; BUILD_UNINSTALLER

; Minimal uninstaller welcome (no marketing copy).
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Remove Fleet"
  !define MUI_WELCOMEPAGE_TEXT "This removes Fleet. Your saved settings and account sessions stay unless you clear them in Fleet first."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
