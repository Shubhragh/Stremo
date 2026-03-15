param(
  [Parameter(Mandatory = $false)]
  [string]$VideoId
)

$ErrorActionPreference = "Stop"

Write-Host "== ScalaStream failure demo =="
Write-Host "Stopping transcode worker..."
docker compose stop transcode-worker

Write-Host "Worker stopped. Upload a video now from UI (http://localhost:3000)."
Write-Host "Waiting 15 seconds before restarting worker..."
Start-Sleep -Seconds 15

Write-Host "Restarting transcode worker..."
docker compose start transcode-worker

if ($VideoId) {
  Write-Host "Polling status for video: $VideoId"
  for ($i = 0; $i -lt 30; $i++) {
    try {
      $status = Invoke-RestMethod -Method Get -Uri "http://localhost:8080/videos/$VideoId/status"
      Write-Host ("Attempt {0}: {1}" -f ($i + 1), $status.status)
      if ($status.status -eq "READY") {
        Write-Host "Recovery successful: video reached READY state."
        exit 0
      }
    } catch {
      Write-Host "Status check failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 3
  }
  Write-Host "Video did not reach READY state within polling window."
} else {
  Write-Host "No VideoId passed. Use docker logs to show recovery:"
  Write-Host "docker compose logs -f transcode-worker"
}
