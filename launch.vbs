' Skip the launch when something is already serving :3000. A logon event that
' does not follow a reboot leaves the previous instance alive, and a second node
' then blocks before it ever reaches app.listen() instead of failing loudly.
Dim shell, rc
Set shell = CreateObject("WScript.Shell")
rc = shell.Run("cmd /c netstat -ano | findstr /C:"":3000 "" | findstr /C:""LISTENING"" >nul", 0, True)
If rc <> 0 Then
  shell.Run "node server.js", 0, False
End If
