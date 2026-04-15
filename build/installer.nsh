!macro customInstall
  CreateShortCut "$SMSTARTUP\Tech Notify.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 SW_SHOWNORMAL
!macroend

!macro customUnInstall
  Delete "$SMSTARTUP\Tech Notify.lnk"
!macroend
