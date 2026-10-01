# 停止 Windows 端网关（node ... src\main.ts），返回被停的 pid 列表。
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src.main' }
foreach ($p in $procs) {
    Write-Output ("STOP " + $p.ProcessId)
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
if (-not $procs) { Write-Output "NONE" }
# 8790 仍被谁占着？
$conn = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
    $op = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    Write-Output ("OCCUPY " + $op.ProcessName)
} else {
    Write-Output "FREE"
}
