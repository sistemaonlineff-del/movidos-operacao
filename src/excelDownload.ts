export async function downloadExcel(filename: string, sheetName: string, rows: Record<string, unknown>[]) {
  const XLSX = await import('xlsx')
  const workbook = XLSX.utils.book_new()
  const sheet = XLSX.utils.json_to_sheet(rows)
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName.slice(0, 31))
  XLSX.writeFile(workbook, filename)
}
