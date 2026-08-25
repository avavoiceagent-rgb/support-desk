<#
.SYNOPSIS
    Sends one ad-hoc test email to the support desk inbox, from PowerShell.

.DESCRIPTION
    The Node sender beside this file covers the nine scripted scenarios. This
    is for the other half of testing: the one-off email written to prove a
    specific fix, which until now meant typing it into Gmail by hand and
    hoping the wording matched last time.

    The app password is never written into this script, never printed, and
    never passed on a command line where it would land in your PowerShell
    history. It is read from the .env file beside this one if you have already
    set the Node sender up, and otherwise prompted for — Windows collects it
    into a SecureString that this script hands straight to the mail client.

.PARAMETER Subject
    The subject line. A run tag is appended unless you pass -NoTag.

    Gmail threads by subject and sender, so an untagged repeat of a subject
    arrives as a reply on the existing ticket: no new ticket, no new draft,
    and a re-test that quietly proves nothing. That has happened here before.

.PARAMETER Body
    The plain-text body. Use a here-string for anything multi-line.

.PARAMETER NoTag
    Send the exact subject given. Use this deliberately, to reply onto an
    existing thread rather than to open a new ticket.

.EXAMPLE
    .\send.ps1 -Subject "Car to JFK on 20 October" -Body @"
    Hi,

    Please book a car for 20 October. Pickup from The Ritz-Carlton,
    50 Central Park South, New York, going to JFK. My flight is
    BA178 departing at 8:30 PM, international. Two passengers,
    three bags.

    Thanks
    Apurva
    "@
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Subject,
    [Parameter(Mandatory = $true)][string]$Body,
    [switch]$NoTag
)

$ErrorActionPreference = "Stop"

# Same file the Node sender uses, so setting one up sets up both. Absent is
# not an error — you are asked instead.
function Read-DotEnv {
    $file = Join-Path $PSScriptRoot ".env"
    $values = @{}
    if (-not (Test-Path $file)) { return $values }
    foreach ($line in Get-Content $file) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
        $eq = $trimmed.IndexOf("=")
        if ($eq -lt 1) { continue }
        $values[$trimmed.Substring(0, $eq).Trim()] = $trimmed.Substring($eq + 1).Trim()
    }
    return $values
}

$env_ = Read-DotEnv
$from = $env_["GMAIL_USER"]
$to   = $env_["TO_ADDRESS"]

if (-not $from) { $from = Read-Host "Sending Gmail address" }
if (-not $to)   { $to   = "avavoiceagent@gmail.com" }

if ($env_["GMAIL_APP_PASSWORD"]) {
    $secret = ConvertTo-SecureString $env_["GMAIL_APP_PASSWORD"] -AsPlainText -Force
} else {
    Write-Host "No app password in .env. This is the 16-character app password from" -ForegroundColor Yellow
    Write-Host "https://myaccount.google.com/apppasswords, not your Gmail password." -ForegroundColor Yellow
    $secret = Read-Host "App password for $from" -AsSecureString
}
$credential = New-Object System.Management.Automation.PSCredential($from, $secret)

# Seconds included: two sends of the same subject inside one minute would
# otherwise share a tag and thread onto each other, which is the exact problem
# the tag exists to prevent.
$tag = Get-Date -Format "HHmmss"
$finalSubject = if ($NoTag) { $Subject } else { "$Subject [$tag]" }

$message = New-Object System.Net.Mail.MailMessage
$message.From = $from
$message.To.Add($to)
$message.Subject = $finalSubject
$message.Body = $Body
$message.IsBodyHtml = $false

# System.Net.Mail rather than Send-MailMessage, which is deprecated and warns
# on PowerShell 7 while still being the only thing that works on 5.1.
$client = New-Object System.Net.Mail.SmtpClient("smtp.gmail.com", 587)
$client.EnableSsl = $true
$client.Credentials = New-Object System.Net.NetworkCredential(
    $credential.UserName,
    $credential.GetNetworkCredential().Password
)

try {
    $client.Send($message)
    Write-Host "Sent to $to" -ForegroundColor Green
    Write-Host "  Subject: $finalSubject"
    Write-Host ""
    Write-Host "The desk polls Gmail on a timer, so give it a minute or two:"
    Write-Host "  https://support-desk-production-90e4.up.railway.app/tickets"
} catch {
    # Gmail's own words. "Username and Password not accepted" almost always
    # means an ordinary Gmail password was used instead of an app password.
    Write-Host "Not sent: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    $message.Dispose()
    $client.Dispose()
}
