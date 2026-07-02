; Fleet custom installer — fully custom card UI, no wizard chrome at all.
;
; The window is stripped to a borderless, rounded, all-white card:
;   page 1  "Update detected" / "Welcome to Fleet" + flat black Update/Install
;           button and a quiet Cancel — both custom-drawn (no native buttons).
;   page 2  the install progress, restyled to a thin monochrome bar centered
;           on the same white card (status text, buttons and theme removed).
;   then    Fleet launches and the installer closes itself. No finish page.
; electron-updater runs this with /S for background updates — silent installs
; never execute any of this UI.
;
; NOTE: this file is !included BEFORE common.nsh/assistedInstaller.nsh, so all
; functions live inside the custom page macros — those expand later, when the
; electron-builder macros exist. Only macros/defines may live at top level.

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

!define FLEET_INK 0x101114
!define FLEET_MUTED 0x8A8F98
!define FLEET_WHITE 0xFFFFFF
; COLORREF (BGR) variants for the progress bar messages
; (PBM_SETBARCOLOR / PBM_SETBKCOLOR come from WinMessages.nsh)
!define FLEET_INK_BGR 0x141110
!define FLEET_TRACK_BGR 0xF4F2F1

!macro customHeader
  AutoCloseWindow true
!macroend

; Skip the "install for all users / only me" page — always per-user, silent.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro FleetHideChrome ID
  GetDlgItem $R9 $HWNDPARENT ${ID}
  ShowWindow $R9 ${SW_HIDE}
!macroend

; ---------------------------------------------------------------- page 1 ----
!macro customWelcomePage
  Var FleetDlg
  Var FleetHeading
  Var FleetSub
  Var FleetGo
  Var FleetCancel
  Var FleetHeadFont
  Var FleetSubFont
  Var FleetBtnFont
  Var FleetIsUpdate
  Var FleetSkinned

  ; One-time window surgery: borderless + rounded + white, all wizard chrome
  ; (title bar, header band, branding rows, native buttons) removed, page
  ; area expanded to fill the whole card.
  Function FleetSkinWindow
    ${If} $FleetSkinned == "1"
      Return
    ${EndIf}
    StrCpy $FleetSkinned "1"

    !insertmacro FleetHideChrome 1034
    !insertmacro FleetHideChrome 1035
    !insertmacro FleetHideChrome 1036
    !insertmacro FleetHideChrome 1037
    !insertmacro FleetHideChrome 1038
    !insertmacro FleetHideChrome 1039
    !insertmacro FleetHideChrome 1028
    !insertmacro FleetHideChrome 1256
    !insertmacro FleetHideChrome 1045
    !insertmacro FleetHideChrome 1     ; Next
    !insertmacro FleetHideChrome 2     ; Cancel
    !insertmacro FleetHideChrome 3     ; Back

    SetCtlColors $HWNDPARENT ${FLEET_INK} ${FLEET_WHITE}

    ; Strip WS_CAPTION | WS_SYSMENU | WS_THICKFRAME  (GWL_STYLE = -16).
    System::Call `user32::GetWindowLong(i $HWNDPARENT, i -16) i .r0`
    IntOp $0 $0 & 0xFF33FFFF
    System::Call `user32::SetWindowLong(i $HWNDPARENT, i -16, i r0)`
    System::Call `user32::SetWindowPos(i $HWNDPARENT, i 0, i 0, i 0, i 0, i 0, i 0x37)`

    ; Rounded corners.
    System::Call `*(i, i, i, i) i .R0`
    System::Call `user32::GetWindowRect(i $HWNDPARENT, i R0)`
    System::Call `*$R0(i .r1, i .r2, i .r3, i .r4)`
    System::Free $R0
    IntOp $3 $3 - $1
    IntOp $4 $4 - $2
    System::Call `gdi32::CreateRoundRectRgn(i 0, i 0, i r3, i r4, i 20, i 20) i .r5`
    System::Call `user32::SetWindowRgn(i $HWNDPARENT, i r5, i 1)`

    ; Page area (1018) fills the entire card — no button strip.
    System::Call `*(i, i, i, i) i .R0`
    System::Call `user32::GetClientRect(i $HWNDPARENT, i R0)`
    System::Call `*$R0(i, i, i .r1, i .r2)`
    System::Free $R0
    GetDlgItem $R9 $HWNDPARENT 1018
    System::Call `user32::MoveWindow(i $R9, i 0, i 0, i r1, i r2, i 1)`
  FunctionEnd

  Function FleetGoClick
    Pop $0
    SendMessage $HWNDPARENT ${WM_COMMAND} 1 0   ; wizard "Next"
  FunctionEnd

  Function FleetCancelClick
    Pop $0
    SendMessage $HWNDPARENT ${WM_COMMAND} 2 0   ; wizard "Cancel"
  FunctionEnd

  Function FleetWelcomeShow
    ; Existing install => update. $INSTDIR resolves to the prior location
    ; during .onInit, so the exe already being there means an update.
    StrCpy $FleetIsUpdate "0"
    ${If} ${FileExists} "$INSTDIR\Fleet.exe"
      StrCpy $FleetIsUpdate "1"
    ${EndIf}

    Call FleetSkinWindow

    nsDialogs::Create 1018
    Pop $FleetDlg
    ${If} $FleetDlg == error
      Abort
    ${EndIf}
    SetCtlColors $FleetDlg ${FLEET_INK} ${FLEET_WHITE}

    CreateFont $FleetHeadFont "Segoe UI Semibold" "21" "600"
    CreateFont $FleetSubFont  "Segoe UI"          "10" "400"
    CreateFont $FleetBtnFont  "Segoe UI Semibold" "11" "600"

    ${NSD_CreateLabel} 0 26% 100% 15% ""
    Pop $FleetHeading
    ${NSD_AddStyle} $FleetHeading 0x00000001 ; SS_CENTER
    SetCtlColors $FleetHeading ${FLEET_INK} ${FLEET_WHITE}
    SendMessage $FleetHeading ${WM_SETFONT} $FleetHeadFont 1

    ${NSD_CreateLabel} 0 43% 100% 9% ""
    Pop $FleetSub
    ${NSD_AddStyle} $FleetSub 0x00000001
    SetCtlColors $FleetSub ${FLEET_MUTED} ${FLEET_WHITE}
    SendMessage $FleetSub ${WM_SETFONT} $FleetSubFont 1

    ; Flat black action "button" (a clickable centered static — no native
    ; button chrome anywhere in this installer).
    ${NSD_CreateLabel} 35% 62% 30% 11% ""
    Pop $FleetGo
    ${NSD_AddStyle} $FleetGo 0x00000301 ; SS_CENTER|SS_NOTIFY|SS_CENTERIMAGE
    SetCtlColors $FleetGo ${FLEET_WHITE} ${FLEET_INK}
    SendMessage $FleetGo ${WM_SETFONT} $FleetBtnFont 1
    ${NSD_OnClick} $FleetGo FleetGoClick

    ${NSD_CreateLabel} 35% 78% 30% 8% "Cancel"
    Pop $FleetCancel
    ${NSD_AddStyle} $FleetCancel 0x00000301
    SetCtlColors $FleetCancel ${FLEET_MUTED} ${FLEET_WHITE}
    SendMessage $FleetCancel ${WM_SETFONT} $FleetSubFont 1
    ${NSD_OnClick} $FleetCancel FleetCancelClick

    ${If} $FleetIsUpdate == "1"
      ${NSD_SetText} $FleetHeading "Update detected"
      ${NSD_SetText} $FleetSub "Fleet will update to the latest version"
      ${NSD_SetText} $FleetGo "Update"
    ${Else}
      ${NSD_SetText} $FleetHeading "Welcome to Fleet"
      ${NSD_SetText} $FleetSub "Fleet will be set up on your PC"
      ${NSD_SetText} $FleetGo "Install"
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Page custom FleetWelcomeShow
!macroend

; ---------------------------------------------------------------- page 2 ----
; This macro expands immediately before MUI_PAGE_INSTFILES, so the SHOW
; define below attaches to the progress page: restyle it into a thin
; monochrome bar centered on the white card.
!macro customPageAfterChangeDir
  Function FleetInstFilesShow
    ; MUI re-shows wizard buttons on page change — remove them again.
    !insertmacro FleetHideChrome 1
    !insertmacro FleetHideChrome 2
    !insertmacro FleetHideChrome 3

    ; Inner install page dialog.
    FindWindow $0 "#32770" "" $HWNDPARENT
    ${If} $0 == 0
      Return
    ${EndIf}
    SetCtlColors $0 ${FLEET_INK} ${FLEET_WHITE}

    ; Hide the status line + details control; only the bar remains.
    GetDlgItem $1 $0 1006
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1027
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1016
    ShowWindow $1 ${SW_HIDE}

    ; Thin, unthemed, monochrome progress bar centered on the card.
    System::Call `*(i, i, i, i) i .R0`
    System::Call `user32::GetClientRect(i r0, i R0)`
    System::Call `*$R0(i, i, i .r2, i .r3)`
    System::Free $R0
    GetDlgItem $1 $0 1004
    System::Call `uxtheme::SetWindowTheme(i r1, w " ", w " ")`
    IntOp $4 $2 * 15
    IntOp $4 $4 / 100          ; x = 15%
    IntOp $5 $2 * 70
    IntOp $5 $5 / 100          ; width = 70%
    IntOp $6 $3 / 2            ; y = middle
    System::Call `user32::MoveWindow(i r1, i r4, i r6, i r5, i 6, i 1)`
    SendMessage $1 ${PBM_SETBARCOLOR} 0 ${FLEET_INK_BGR}
    SendMessage $1 ${PBM_SETBKCOLOR} 0 ${FLEET_TRACK_BGR}
  FunctionEnd

  !define MUI_PAGE_CUSTOMFUNCTION_SHOW FleetInstFilesShow
!macroend

; ---------------------------------------------------------------- finish ----
; No finish page: launch Fleet from the (never-shown) page pre-callback and
; let the installer close itself.
!macro customFinishPage
  Function FleetLaunchPre
    ; Can't reuse the StartApp macro here: installSection.nsh also inserts it
    ; (silent force-run path) and its Var /GLOBAL would collide. Same call:
    ${IfNot} ${Silent}
      ${if} ${isUpdated}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      ${else}
        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
      ${endif}
    ${EndIf}
    Abort
  FunctionEnd

  Page custom FleetLaunchPre
!macroend

; Minimal uninstaller welcome (stock chrome is fine for uninstall).
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Remove Fleet"
  !define MUI_WELCOMEPAGE_TEXT "This removes Fleet. Your saved settings and account sessions stay unless you clear them in Fleet first."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
