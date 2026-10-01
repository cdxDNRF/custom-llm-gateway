$conn = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) { Write-Output "STATE STOPPED"; exit }
$p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
Write-Output ("STATE RUNNING pid=" + $p.Id + " name=" + $p.ProcessName)
try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8790/api/overview' -UseBasicParsing -TimeoutSec 5
    $j = $r.Content | ConvertFrom-Json
    foreach ($x in $j.providers) {
        Write-Output ("PROV " + $x.id + " " + $x.port + " " + $x.accounts.Count)
    }
} catch { Write-Output "PROV NONE" }
