; Fleet custom installer — fully custom card UI, no wizard chrome at all.
;
; Card states (detected from the installed DisplayVersion in the registry):
;   fresh   "Welcome to Fleet"              + "Version X.Y.Z"        [Install]
;   update  "Update detected"               + "Fleet A.B.C -> X.Y.Z" [Update]
;   same    "You already have Fleet installed!" + version note       [Reinstall]
; Progress page: same white card, heading + version and a clean thin bar.
; Fleet launches when done; installer closes itself. No finish page.
; Silent (/S) auto-updates never execute any of this UI.
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
!define FLEET_INK_BGR 0x141110
!define FLEET_TRACK_BGR 0xEDE9E7

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
  Var FleetState      ; "fresh" | "update" | "same"
  Var FleetOldVer
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

    ; Rounded corners: ask DWM first (Windows 11 renders smooth antialiased
    ; corners with a shadow); fall back to a subtle 8px window region on
    ; Windows 10, where regions are the only option.
    System::Call `dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 33, *i 2, i 4) i .r9`
    ${If} $9 != 0
      System::Call `*(i, i, i, i) i .R0`
      System::Call `user32::GetWindowRect(i $HWNDPARENT, i R0)`
      System::Call `*$R0(i .r1, i .r2, i .r3, i .r4)`
      System::Free $R0
      IntOp $3 $3 - $1
      IntOp $4 $4 - $2
      IntOp $3 $3 + 1
      IntOp $4 $4 + 1
      ; Small radius: window regions can't antialias, and a subtle curve shows
      ; far fewer stair-steps than a big one. (Windows 11 uses smooth DWM
      ; corners via the attribute above and never reaches this path.)
      System::Call `gdi32::CreateRoundRectRgn(i 0, i 0, i r3, i r4, i 12, i 12) i .r5`
      System::Call `user32::SetWindowRgn(i $HWNDPARENT, i r5, i 1)`
    ${EndIf}

    ; Page area (1018) fills the entire card — no button strip.
    System::Call `*(i, i, i, i) i .R0`
    System::Call `user32::GetClientRect(i $HWNDPARENT, i R0)`
    System::Call `*$R0(i, i, i .r1, i .r2)`
    System::Free $R0
    GetDlgItem $R9 $HWNDPARENT 1018
    System::Call `user32::MoveWindow(i $R9, i 0, i 0, i r1, i r2, i 1)`

    CreateFont $FleetHeadFont "Segoe UI Semibold" "18" "600"
    CreateFont $FleetSubFont  "Segoe UI"          "10" "400"
    CreateFont $FleetBtnFont  "Segoe UI Semibold" "11" "600"
  FunctionEnd

  Function FleetGoClick
    Pop $0
    SendMessage $HWNDPARENT ${WM_COMMAND} 1 0   ; wizard "Next"
  FunctionEnd

  Function FleetCancelClick
    Pop $0
    ; Exit directly. Never surface the stock wizard confirmation dialog.
    Quit
  FunctionEnd

  Function FleetWelcomeShow
    ; Detect the installed copy + its version (written by previous installs).
    StrCpy $FleetState "fresh"
    StrCpy $FleetOldVer ""
    ReadRegStr $FleetOldVer SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" DisplayVersion
    ${If} ${FileExists} "$INSTDIR\Fleet.exe"
      ${If} $FleetOldVer == "${VERSION}"
        StrCpy $FleetState "same"
      ${Else}
        StrCpy $FleetState "update"
      ${EndIf}
    ${EndIf}

    Call FleetSkinWindow

    nsDialogs::Create 1018
    Pop $FleetDlg
    ${If} $FleetDlg == error
      Abort
    ${EndIf}
    SetCtlColors $FleetDlg ${FLEET_INK} ${FLEET_WHITE}

    ; Generous bounds keep Segoe UI from clipping at 125-200% DPI, and the
    ; near-full width fits "You already have Fleet installed!" comfortably.
    ${NSD_CreateLabel} 2% 24% 96% 22% ""
    Pop $FleetHeading
    ${NSD_AddStyle} $FleetHeading 0x00000001 ; SS_CENTER
    SetCtlColors $FleetHeading ${FLEET_INK} ${FLEET_WHITE}
    SendMessage $FleetHeading ${WM_SETFONT} $FleetHeadFont 1

    ${NSD_CreateLabel} 8% 46% 84% 12% ""
    Pop $FleetSub
    ${NSD_AddStyle} $FleetSub 0x00000001
    SetCtlColors $FleetSub ${FLEET_MUTED} ${FLEET_WHITE}
    SendMessage $FleetSub ${WM_SETFONT} $FleetSubFont 1

    ; Flat black action "button" (clickable centered static — no native
    ; button chrome anywhere in this installer).
    ${NSD_CreateLabel} 34% 62% 32% 13% ""
    Pop $FleetGo
    ${NSD_AddStyle} $FleetGo 0x00000301 ; SS_CENTER|SS_NOTIFY|SS_CENTERIMAGE
    SetCtlColors $FleetGo ${FLEET_WHITE} ${FLEET_INK}
    SendMessage $FleetGo ${WM_SETFONT} $FleetBtnFont 1
    ${NSD_OnClick} $FleetGo FleetGoClick

    ${NSD_CreateLabel} 34% 80% 32% 9% "Cancel"
    Pop $FleetCancel
    ${NSD_AddStyle} $FleetCancel 0x00000301
    SetCtlColors $FleetCancel ${FLEET_MUTED} ${FLEET_WHITE}
    SendMessage $FleetCancel ${WM_SETFONT} $FleetSubFont 1
    ${NSD_OnClick} $FleetCancel FleetCancelClick

    ${If} $FleetState == "same"
      ${NSD_SetText} $FleetHeading "You already have Fleet installed!"
      ${NSD_SetText} $FleetSub "Fleet ${VERSION} is already on this PC"
      ${NSD_SetText} $FleetGo "Reinstall"
    ${ElseIf} $FleetState == "update"
      ${NSD_SetText} $FleetHeading "Update detected"
      ${If} $FleetOldVer != ""
        ${NSD_SetText} $FleetSub "Fleet $FleetOldVer to ${VERSION}"
      ${Else}
        ${NSD_SetText} $FleetSub "Updating Fleet to ${VERSION}"
      ${EndIf}
      ${NSD_SetText} $FleetGo "Update"
    ${Else}
      ${NSD_SetText} $FleetHeading "Welcome to Fleet"
      ${NSD_SetText} $FleetSub "Version ${VERSION}"
      ${NSD_SetText} $FleetGo "Install"
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Page custom FleetWelcomeShow
!macroend

; ---------------------------------------------------------------- page 2 ----
; This macro expands immediately before MUI_PAGE_INSTFILES, so the SHOW
; define below attaches to the progress page: white card, heading + version,
; and a clean thin monochrome bar (no borders, no status spam, no buttons).
!macro customPageAfterChangeDir
  Function FleetInstFilesShow
    ; MUI re-shows wizard buttons on page change — remove them again.
    !insertmacro FleetHideChrome 1
    !insertmacro FleetHideChrome 2
    !insertmacro FleetHideChrome 3
    !insertmacro FleetHideChrome 1034
    !insertmacro FleetHideChrome 1035
    !insertmacro FleetHideChrome 1036
    !insertmacro FleetHideChrome 1037
    !insertmacro FleetHideChrome 1038
    !insertmacro FleetHideChrome 1039
    !insertmacro FleetHideChrome 1028
    !insertmacro FleetHideChrome 1256
    !insertmacro FleetHideChrome 1045

    ; Inner install page dialog.
    FindWindow $0 "#32770" "" $HWNDPARENT
    ${If} $0 == 0
      Return
    ${EndIf}
    SetCtlColors $0 ${FLEET_INK} ${FLEET_WHITE}

    ; The inner page keeps the ORIGINAL 1018 placeholder geometry, not the
    ; full-card one — stretch it first or everything centers off-card.
    System::Call `*(i, i, i, i) i .R0`
    System::Call `user32::GetClientRect(i $HWNDPARENT, i R0)`
    System::Call `*$R0(i, i, i .r2, i .r3)`
    System::Free $R0
    System::Call `user32::MoveWindow(i r0, i 0, i 0, i r2, i r3, i 1)`

    ; Hide the stock status line and details list; only the bar remains.
    GetDlgItem $1 $0 1006
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1027
    ShowWindow $1 ${SW_HIDE}
    GetDlgItem $1 $0 1016
    ShowWindow $1 ${SW_HIDE}

    ; Heading + version, centered above the bar ($2/$3 = full card size now).
    IntOp $4 $3 * 27
    IntOp $4 $4 / 100
    ${If} $FleetState == "update"
    ${OrIf} $FleetState == "same"
      StrCpy $7 "Updating Fleet"
    ${Else}
      StrCpy $7 "Installing Fleet"
    ${EndIf}
    System::Call `user32::CreateWindowEx(i 0, t "STATIC", t "$7", i 0x50000201, i 0, i r4, i r2, i 48, i r0, i 0, i 0, i 0) i .r5`
    SendMessage $5 ${WM_SETFONT} $FleetHeadFont 1
    SetCtlColors $5 ${FLEET_INK} ${FLEET_WHITE}
    IntOp $4 $4 + 50
    System::Call `user32::CreateWindowEx(i 0, t "STATIC", t "Version ${VERSION}", i 0x50000201, i 0, i r4, i r2, i 28, i r0, i 0, i 0, i 0) i .r5`
    SendMessage $5 ${WM_SETFONT} $FleetSubFont 1
    SetCtlColors $5 ${FLEET_MUTED} ${FLEET_WHITE}
    ; Anchor the bar below the version line instead of using an unrelated
    ; percentage that can overlap the text on shorter/scaled installer cards.
    IntOp $8 $4 + 52

    ; The bar: strip WS_BORDER + client/static edges, unskin the theme so the
    ; monochrome colors apply, then center it as a clean 8px line.
    GetDlgItem $1 $0 1004
    System::Call `uxtheme::SetWindowTheme(i r1, w " ", w " ")`
    System::Call `user32::GetWindowLong(i r1, i -16) i .r6`
    IntOp $6 $6 & 0xFF7FFFFF   ; ~WS_BORDER
    System::Call `user32::SetWindowLong(i r1, i -16, i r6)`
    System::Call `user32::GetWindowLong(i r1, i -20) i .r6`
    IntOp $6 $6 & 0xFFFDFDFF   ; ~WS_EX_CLIENTEDGE & ~WS_EX_STATICEDGE
    System::Call `user32::SetWindowLong(i r1, i -20, i r6)`
    IntOp $4 $2 * 18
    IntOp $4 $4 / 100          ; x = 18%
    IntOp $5 $2 * 64
    IntOp $5 $5 / 100          ; width = 64%
    System::Call `user32::SetWindowPos(i r1, i 0, i r4, i r8, i r5, i 8, i 0x34)` ; NOZORDER|NOACTIVATE|FRAMECHANGED
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
