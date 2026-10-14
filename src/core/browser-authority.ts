import type { AuthContext } from '../auth/types.js'

export type BrowserHostAuthority =
  | Readonly<{ kind: 'account'; tenantId: string; userId: string }>
  | Readonly<{ kind: 'instance'; tenantId: 'default'; instanceId: string }>

const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)

/** Only authentication and the frozen owned instance gate supply authority; body/metadata are not inputs. */
export function browserAuthorityFromTrustedState(auth: AuthContext | undefined,
  proof?: { gateVerified: boolean; authenticationRequired: boolean; instanceId: string }): BrowserHostAuthority | undefined {
  if (!auth || !id(auth.tenantId)) return undefined
  if (auth.method !== 'none') {
    return id(auth.userId) ? Object.freeze({ kind: 'account', tenantId: auth.tenantId, userId: auth.userId }) : undefined
  }
  if (auth.tenantId !== 'default' || auth.userId !== undefined || !proof?.gateVerified || proof.authenticationRequired || !id(proof.instanceId)) return undefined
  return Object.freeze({ kind: 'instance', tenantId: 'default', instanceId: proof.instanceId })
}

export function browserAuthorityKey(authority: BrowserHostAuthority): string {
  return authority.kind === 'account' ? JSON.stringify(['account', authority.tenantId, authority.userId])
    : JSON.stringify(['instance', 'default', authority.instanceId])
}

export function snapshotBrowserAuthority(value?: BrowserHostAuthority): BrowserHostAuthority | undefined {
  if (!value || !id(value.tenantId)) return undefined
  if (value.kind === 'account' && id(value.userId)) return Object.freeze({ kind: 'account', tenantId: value.tenantId, userId: value.userId })
  if (value.kind === 'instance' && value.tenantId === 'default' && id(value.instanceId)) return Object.freeze({ kind: 'instance', tenantId: 'default', instanceId: value.instanceId })
  return undefined
}
