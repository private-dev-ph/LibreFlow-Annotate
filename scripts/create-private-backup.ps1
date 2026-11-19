param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$security = New-Object System.Security.AccessControl.FileSecurity
$security.SetOwner($identity)
$security.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$security.AddAccessRule($rule)

$stream = New-Object System.IO.FileStream(
  $Path,
  [System.IO.FileMode]::CreateNew,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.IO.FileShare]::None,
  4096,
  [System.IO.FileOptions]::WriteThrough,
  $security
)
try {
  $applied = $stream.GetAccessControl()
  $rules = @($applied.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $applied.AreAccessRulesProtected -or $rules.Count -ne 1 -or
      $rules[0].IdentityReference.Value -ne $identity.Value -or
      $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      ([int]$rules[0].FileSystemRights -band [int][System.Security.AccessControl.FileSystemRights]::FullControl) -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl) {
    throw 'The backup ACL was not applied as an owner-only rule.'
  }
  [Console]::OpenStandardInput().CopyTo($stream)
  $stream.Flush($true)
} finally {
  $stream.Dispose()
}
