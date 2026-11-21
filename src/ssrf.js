import dns from 'node:dns/promises';
import net from 'node:net';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7)); // IPv4-mapped
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

// Resolve the hostname ourselves and refuse private ranges, so a user-supplied URL
// can't make the dispatcher call internal services. Throws a non-retryable error.
export async function assertPublicTarget(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });

  if (addresses.some(({ address }) => isPrivateIp(address))) {
    const err = new Error('Destination resolves to a private or internal address');
    err.permanent = true;
    throw err;
  }
}
