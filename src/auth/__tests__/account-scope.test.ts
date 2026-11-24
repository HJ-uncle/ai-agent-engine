import { describe, expect, it } from 'vitest'
import { isManagedChildTenant, isPersonalAccountTenant } from '../account-scope.js'

describe('managed account tenant classification', () => {
  it('recognizes only issued child tenant IDs, not a legacy tenant sharing the prefix', () => {
    expect(isManagedChildTenant('account_child_00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isManagedChildTenant('account_child_analytics')).toBe(false)
    expect(isManagedChildTenant('account_child_00000000-0000-4000-8000-000000000001-extra')).toBe(false)
    expect(isManagedChildTenant('tenant-account_child-00000000-0000-4000-8000-000000000001')).toBe(false)
  })

  it('keeps personal account classification independent from child classification', () => {
    expect(isPersonalAccountTenant('account_child_analytics')).toBe(true)
    expect(isPersonalAccountTenant('legacy-tenant')).toBe(false)
    expect(isPersonalAccountTenant('')).toBe(false)
  })
})
