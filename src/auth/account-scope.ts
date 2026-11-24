/**
 * Reserved at issuance: managed spaces must never inherit local desktop or
 * external identity authority. Child tenants are issued with a UUID suffix;
 * keep the shape check exact so an older, independently deployed tenant named
 * `account_child_*` is not misclassified just because of a human-chosen prefix.
 */
export const CHILD_TENANT_PREFIX = 'account_child_'
const CHILD_TENANT_ID = /^account_child_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export const isManagedChildTenant = (tenantId: string) => typeof tenantId === 'string' && CHILD_TENANT_ID.test(tenantId)
export const isPersonalAccountTenant = (tenantId: string) => typeof tenantId === 'string' && tenantId.startsWith('account_')
