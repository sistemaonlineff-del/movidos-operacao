export const LABEL_TEST_EMAIL = 'fabioaf9@gmail.com'

export function isLabelTester(email: string | null | undefined): boolean {
  return email?.trim().toLowerCase() === LABEL_TEST_EMAIL
}
