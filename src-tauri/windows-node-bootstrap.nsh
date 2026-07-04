!include "LogicLib.nsh"
!include "x64.nsh"

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Checking Node.js runtime..."
  ClearErrors
  nsExec::ExecToStack 'node --version'
  Pop $0
  Pop $1
  ${If} $0 == 0
    DetailPrint "Node.js runtime found: $1"
  ${Else}
    DetailPrint "Node.js runtime not found. Installing Node.js LTS..."
    StrCpy $2 "$TEMP\fleet-node-lts-x64.msi"
    nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri ''https://nodejs.org/dist/latest-v20.x/node-v20.19.4-x64.msi'' -OutFile ''$2''"'
    Pop $3
    Pop $6
    ${If} $3 != 0
      MessageBox MB_ICONSTOP "Fleet needs Node.js to run its backend service, but the Node.js installer could not be downloaded. Please install Node.js LTS from nodejs.org and run Fleet setup again. Exit code: $3"
      Abort
    ${EndIf}

    DetailPrint "Installing Node.js LTS..."
    nsExec::ExecToStack 'msiexec /i "$2" /qn /norestart'
    Pop $4
    Pop $5
    ${If} $4 != 0
      MessageBox MB_ICONSTOP "Fleet needs Node.js to run its backend service, but the Node.js installer failed. Please install Node.js LTS from nodejs.org and run Fleet setup again. Exit code: $4"
      Abort
    ${EndIf}

    Delete "$2"
    DetailPrint "Node.js installation finished."
  ${EndIf}
!macroend
