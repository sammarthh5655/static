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

' Build preloads if they are missing or older than their sources.
needsBuild = Not fso.FileExists(root & "\build\chrome.preload.cjs")
If Not needsBuild Then
  Set builtFile = fso.GetFile(root & "\build\chrome.preload.cjs")
  Set srcFile = fso.GetFile(root & "\src\preload\chrome.js")
  Set tabFile = fso.GetFile(root & "\src\preload\tab.js")
  If srcFile.DateLastModified > builtFile.DateLastModified Or _
     tabFile.DateLastModified > builtFile.DateLastModified Then needsBuild = True
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
