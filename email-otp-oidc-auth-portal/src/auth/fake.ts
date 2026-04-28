import type { AuthAdapter, VerifiedUser } from './adapter.js'

type FakeState = { issued: Map<string, string> }

export function createFakeAdapter(state: FakeState = { issued: new Map() }): { adapter: AuthAdapter; state: FakeState } {
  const adapter: AuthAdapter = {
    async sendEmailOtp(email: string) {
      state.issued.set(email, '000000')
    },
    async verifyEmailOtp(email: string, token: string): Promise<VerifiedUser> {
      const expected = state.issued.get(email)
      if (!expected || expected !== token) throw new Error('Invalid OTP')
      return { sub: `fake:${email}`, email }
    }
  }

  return { adapter, state }
}

