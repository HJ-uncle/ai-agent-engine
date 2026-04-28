export type VerifiedUser = { sub: string; email: string }

export interface AuthAdapter {
  sendEmailOtp(email: string): Promise<void>
  verifyEmailOtp(email: string, token: string): Promise<VerifiedUser>
}

