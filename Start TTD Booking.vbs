' Double-click to start. Opens the browser with the details form; no console window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(sh.CurrentDirectory & "\node_modules\playwright-core") Then
  sh.Run "cmd /c npm install --no-audit --no-fund", 0, True
End If
sh.Run "node book.js", 0, False
