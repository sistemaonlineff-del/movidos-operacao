export const PRIVATE_FINANCE_EMAILS = ['fabioaf9@gmail.com', 'talitapreviatti@gmail.com'] as const

export function canAccessPrivateFinances(email: string | null | undefined, active: boolean | null | undefined) {
  return active === true && PRIVATE_FINANCE_EMAILS.some(allowed => allowed === email?.trim().toLowerCase())
}