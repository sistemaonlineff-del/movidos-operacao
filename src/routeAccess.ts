export const DELIVERY_ROUTE_EDITOR_EMAIL = 'talitapreviatti@gmail.com'

export function canManageDeliveryRoutes(email: string | null | undefined): boolean {
  return email?.trim().toLowerCase() === DELIVERY_ROUTE_EDITOR_EMAIL
}
