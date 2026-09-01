<#
Exportação local e somente leitura da base Access original.
Gera arquivos JSON em supabase\staging, para conferência antes do envio.
#>
param(
  [string]$DatabasePath = (Join-Path $PSScriptRoot '..\BancoSistema.accdb'),
  [string]$OutputPath = (Join-Path $PSScriptRoot 'staging')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $DatabasePath)) { throw "Access não encontrado: $DatabasePath" }
New-Item -ItemType Directory -Force -Path $OutputPath | Out-Null

function Convert-AccessValue($value) {
  if ($null -eq $value -or $value -is [System.DBNull]) { return $null }
  if ($value -is [datetime]) { return $value.ToString('o') }
  return $value
}

function Export-AccessTable([object]$Connection, [string]$Table) {
  $recordset = $Connection.Execute("SELECT * FROM [$Table]")
  $rows = [System.Collections.Generic.List[object]]::new()
  while (-not $recordset.EOF) {
    $row = [ordered]@{}
    for ($i = 0; $i -lt $recordset.Fields.Count; $i++) {
      $field = $recordset.Fields.Item($i)
      $row[$field.Name] = Convert-AccessValue $field.Value
    }
    $rows.Add([pscustomobject]$row)
    $recordset.MoveNext()
  }
  $recordset.Close()
  $file = Join-Path $OutputPath ("$Table.json")
  @($rows) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $file -Encoding utf8
  Write-Host "${Table}: $($rows.Count) registros -> $file"
}

$connection = New-Object -ComObject ADODB.Connection
$connection.Open("Provider=Microsoft.ACE.OLEDB.12.0;Data Source=$DatabasePath;Persist Security Info=False;")
try {
  'TB_DROPS', 'TB_FINANCEIRO_DROPS', 'TB_FINANCEIRO_EXTRAVIO', 'TB_FINANCEIRO_GERAL', 'TB_FINANCEIRO_HISTORICO_PAGAMENTOS', 'TB_ENVIO_EMAIL', 'TB_USUARIOS' |
    ForEach-Object { Export-AccessTable $connection $_ }
}
finally {
  $connection.Close()
}
