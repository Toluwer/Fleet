!macro customHeader
  !define MUI_ABORTWARNING
  BrandingText "FleetInstaller • Official Fleet setup"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to FleetInstaller"
  !define MUI_WELCOMEPAGE_TEXT "Official Fleet setup for Windows.$\r$\n$\r$\nFleetInstaller installs Fleet with its logo, desktop shortcut, Start menu shortcut, and automatic updates from the official Toluwer/Fleet release channel.$\r$\n$\r$\nAfter installation, Fleet checks for updates itself. You can always use the same FleetInstaller.exe download name."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall Fleet"
  !define MUI_WELCOMEPAGE_TEXT "This removes the Fleet application. Your saved settings and account sessions are kept unless you remove them from Fleet first."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
