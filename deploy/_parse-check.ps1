param([string]$File)
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($File, [ref]$null, [ref]$errs)
if ($errs -and $errs.Count -gt 0) { $errs | ForEach-Object { 'ERR: ' + $_.Message + '  @line ' + $_.Extent.StartLineNumber }; exit 1 }
'PARSE OK'
