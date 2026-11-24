import { BlockList, isIP } from 'node:net'
import type { FastifyRequest } from 'fastify'
import { hasOwnedInstanceToken } from '../../auth/instance-token.js'

let desktopOwnedLoopback = false
export function configureDesktopOwnership(owned: boolean, listenHost: string | undefined, authenticationRequired: boolean): boolean {
  return desktopOwnedLoopback = owned && !authenticationRequired && isLoopbackAddress(listenHost)
}

const loopbackAddresses = new BlockList()
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
loopbackAddresses.addAddress('::1', 'ipv6')
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  const family = isIP(address)
  return family !== 0 && loopbackAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4')
}

/** Only the loopback desktop launcher can bootstrap through HTTP; standalone hosts provision offline. */
export function isOwnedDesktopRequest(request: FastifyRequest): boolean {
  return desktopOwnedLoopback && isLoopbackAddress(request.raw.socket.remoteAddress) && hasOwnedInstanceToken(request.headers)
}

