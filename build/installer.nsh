; Included by electron-builder's NSIS installer.
; On a real uninstall (not when installing a newer version over this one), remove the
; "Run when Windows starts" entry so Windows doesn't try to launch a missing program.
; (The app was called "LinkedIn Message Tracker" before version 3.)
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "IT Business Manager"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "IT Business Manager"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "LinkedIn Message Tracker"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "LinkedIn Message Tracker"
  ${endIf}
!macroend
