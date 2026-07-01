!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to Fleet"
  !define MUI_WELCOMEPAGE_TEXT "Fleet manages Roblox accounts, people, games, and multiple running clients from one clean desktop app.$\r$\n$\r$\nSetup will install Fleet for your Windows account and create the shortcuts you choose. Future updates download automatically from the official Toluwer/Fleet GitHub release."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Uninstall Fleet"
  !define MUI_WELCOMEPAGE_TEXT "This removes the Fleet application. Your saved settings and account sessions are kept unless you remove them from Fleet first."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend
