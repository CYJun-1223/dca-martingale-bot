# Restart the dashboard (web.js) so it re-reads .env / new code. Run it from Task Scheduler (task "bots-web-restart").
# It stops only the node process running apps\server\web.js; the "bots-web" loop starts a fresh one about 10 s later.
# The runner is not touched.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'apps\\server\\web\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; "stopped web.js (pid $($_.ProcessId))" }
