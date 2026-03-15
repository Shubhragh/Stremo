param(
  [Parameter(Mandatory = $false)]
  [int]$Rounds = 2
)

$ErrorActionPreference = "Stop"

function Login-Or-Register {
  param(
    [string]$Email,
    [string]$Password
  )

  $body = @{ email = $Email; password = $Password } | ConvertTo-Json
  try {
    return Invoke-RestMethod -Method POST -Uri "http://localhost:8080/auth/login" -Body $body -ContentType "application/json"
  } catch {
    return Invoke-RestMethod -Method POST -Uri "http://localhost:8080/auth/register" -Body $body -ContentType "application/json"
  }
}

function Send-Search {
  param(
    [string]$Token,
    [string]$Query
  )
  Invoke-RestMethod `
    -Method POST `
    -Uri "http://localhost:8080/videos/history/search" `
    -Headers @{ Authorization = "Bearer $Token" } `
    -Body (@{ query = $Query } | ConvertTo-Json) `
    -ContentType "application/json" | Out-Null
}

function Send-View {
  param(
    [string]$Token,
    [string]$VideoId,
    [string]$SessionId,
    [double]$WatchSeconds,
    [double]$DurationSeconds
  )

  $completion = 0
  if ($DurationSeconds -gt 0) {
    $completion = [Math]::Min(1.0, [Math]::Max(0.0, $WatchSeconds / $DurationSeconds))
  }

  Invoke-RestMethod `
    -Method POST `
    -Uri ("http://localhost:8080/videos/{0}/view" -f $VideoId) `
    -Headers @{ Authorization = "Bearer $Token" } `
    -Body (@{
      sessionId = $SessionId
      watchTimeSeconds = $WatchSeconds
      completionRate = $completion
      durationSeconds = $DurationSeconds
    } | ConvertTo-Json) `
    -ContentType "application/json" | Out-Null
}

Write-Host "== ScalaStream Demo Activity Burst =="

$creator = Login-Or-Register -Email "demo_creator@scalastream.local" -Password "pass1234"
$viewer = Login-Or-Register -Email "demo_viewer@scalastream.local" -Password "pass1234"

$creatorToken = $creator.token
$viewerToken = $viewer.token

$videos = (Invoke-RestMethod -Method GET -Uri "http://localhost:8080/videos?limit=200").items
if (-not $videos -or $videos.Count -lt 2) {
  throw "Need at least 2 READY videos to run demo activity burst."
}

$videoIds = $videos | Select-Object -ExpandProperty id

$creatorQueries = @(
  "distributed systems",
  "hls transcoding",
  "retention analytics"
)
$viewerQueries = @(
  "fun clips",
  "music shorts",
  "creative videos"
)

for ($r = 1; $r -le $Rounds; $r++) {
  Write-Host ("Round {0}/{1}" -f $r, $Rounds)

  Send-Search -Token $creatorToken -Query ($creatorQueries[($r - 1) % $creatorQueries.Count])
  Send-Search -Token $viewerToken -Query ($viewerQueries[($r - 1) % $viewerQueries.Count])

  $creatorVid = $videoIds[($r - 1) % $videoIds.Count]
  $viewerVid = $videoIds[($videoIds.Count - $r) % $videoIds.Count]
  if ($viewerVid -eq $creatorVid) {
    $viewerVid = $videoIds[($r) % $videoIds.Count]
  }

  Send-View -Token $creatorToken -VideoId $creatorVid -SessionId ("burst-c-{0}" -f $r) -WatchSeconds (34 + (2 * $r)) -DurationSeconds 60
  Send-View -Token $viewerToken -VideoId $viewerVid -SessionId ("burst-v-{0}" -f $r) -WatchSeconds (36 + (2 * $r)) -DurationSeconds 60

  Invoke-RestMethod -Method POST -Uri ("http://localhost:8080/videos/{0}/like" -f $creatorVid) -Headers @{ Authorization = "Bearer $creatorToken" } | Out-Null
  Invoke-RestMethod -Method POST -Uri ("http://localhost:8080/videos/{0}/like" -f $viewerVid) -Headers @{ Authorization = "Bearer $viewerToken" } | Out-Null
}

Invoke-RestMethod -Method POST -Uri "http://localhost:8080/feed/train" | Out-Null

$creatorUser = (Invoke-RestMethod -Method GET -Uri "http://localhost:8080/auth/me" -Headers @{ Authorization = "Bearer $creatorToken" }).user
$viewerUser = (Invoke-RestMethod -Method GET -Uri "http://localhost:8080/auth/me" -Headers @{ Authorization = "Bearer $viewerToken" }).user

$creatorFeed = Invoke-RestMethod -Method GET -Uri ("http://localhost:8080/feed/recommended?userId={0}&limit=3" -f $creatorUser.id)
$viewerFeed = Invoke-RestMethod -Method GET -Uri ("http://localhost:8080/feed/recommended?userId={0}&limit=3" -f $viewerUser.id)

Write-Host ("Creator Top-3: {0}" -f (($creatorFeed.items | ForEach-Object { $_.title }) -join " | "))
Write-Host ("Viewer Top-3 : {0}" -f (($viewerFeed.items | ForEach-Object { $_.title }) -join " | "))
Write-Host "Done."
