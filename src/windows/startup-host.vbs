Option Explicit

If WScript.Arguments.Count <> 2 Then
  WScript.Quit 87
End If

Dim executable, argumentLine, commandLine, shell, exitCode
executable = DecodeUtf16Hex(WScript.Arguments(0))
argumentLine = DecodeUtf16Hex(WScript.Arguments(1))
commandLine = Chr(34) & executable & Chr(34)
If Len(argumentLine) > 0 Then
  commandLine = commandLine & " " & argumentLine
End If

Set shell = CreateObject("WScript.Shell")
exitCode = shell.Run(commandLine, 0, True)
WScript.Quit exitCode

Function DecodeUtf16Hex(ByVal encoded)
  Dim output, index, codeUnit
  If Len(encoded) Mod 4 <> 0 Then
    WScript.Quit 87
  End If

  output = ""
  For index = 1 To Len(encoded) Step 4
    codeUnit = CLng("&H" & Mid(encoded, index, 4))
    If codeUnit > 32767 Then
      codeUnit = codeUnit - 65536
    End If
    output = output & ChrW(codeUnit)
  Next
  DecodeUtf16Hex = output
End Function
