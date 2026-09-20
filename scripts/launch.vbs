' Desktop launcher for static.
'
' Runs the browser with no console window. WScript.Shell's Run with a window
' style of 0 keeps cmd hidden; without this, launching from a shortcut leaves
' a black console window open for as long as the browser runs.
'
' This launches the DEV build (electron + src/), not a packaged install. It
' rebuilds the preloads first so the shortcut always runs current code.

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' scripts/ -> project root
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

electron = root & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electron) Then
  MsgBox "Electron is not installed." & vbCrLf & vbCrLf & _
         "Open a terminal in:" & vbCrLf & root & vbCrLf & vbCrLf & _
         "and run:  npm install", 16, "static"
  WScript.Quit 1
End If

' Build the preloads if anything they are built FROM has changed.
'
' This used to compare only src/preload/chrome.js and tab.js against the built
' file. The preload also carries the ad-blocking scriptlets, which are
' generated from src/features/shields/brave/ - so changing those left the
' shortcut running a STALE preload containing the old blocker, while a
' terminal `npm start` rebuilt correctly. That is how "ads still come" and "the
' tests pass" were both true at once.
'
' Rather than listing every input and getting it wrong again, the whole src
' and scripts tree is walked. A build takes about a second; being wrong here
' is silent and costs hours.
needsBuild = Not fso.FileExists(root & "\build\chrome.preload.cjs")
If Not needsBuild Then
  Set builtFile = fso.GetFile(root & "\build\chrome.preload.cjs")
  builtAt = builtFile.DateLastModified
  If NewerThan(fso, root & "\src", builtAt) Then needsBuild = True
  If Not needsBuild Then
    If NewerThan(fso, root & "\scripts", builtAt) Then needsBuild = True
  End If
End If

If needsBuild Then
  ' True = wait for the build to finish before starting the browser.
  shell.CurrentDirectory = root
  shell.Run "cmd /c node scripts\build.cjs", 0, True
End If

' ELECTRON_RUN_AS_NODE is inherited from some editors and would start Electron
' as a plain Node process instead of a desktop app.
Set env = shell.Environment("PROCESS")
env.Remove "ELECTRON_RUN_AS_NODE"

shell.CurrentDirectory = root
shell.Run """" & electron & """ """ & root & """", 1, False

' Is anything under this folder newer than the given time?
'
' Recursive, because the preload's inputs are spread across src/preload,
' src/shared and src/features/shields.
Function NewerThan(fso, folderPath, stamp)
  NewerThan = False
  If Not fso.FolderExists(folderPath) Then Exit Function
  Set folder = fso.GetFolder(folderPath)
  For Each f In folder.Files
    If f.DateLastModified > stamp Then
      NewerThan = True
      Exit Function
    End If
  Next
  For Each subFolder In folder.SubFolders
    If NewerThan(fso, subFolder.Path, stamp) Then
      NewerThan = True
      Exit Function
    End If
  Next
End Function
