Set WshShell = CreateObject("WScript.Shell")
' 隐藏窗口结束 node 服务进程
WshShell.Run "cmd /c taskkill /f /im node.exe", 0, False
