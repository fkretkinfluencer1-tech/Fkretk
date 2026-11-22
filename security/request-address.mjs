import { isIP } from 'node:net';

function normalizeAddress(value) {
  return String(value || '').trim().replace(/^::ffff:/, '');
}

export function requestAddress(request, trustedProxies) {
  const remoteAddress = normalizeAddress(request.socket.remoteAddress);
  if (!trustedProxies.has(remoteAddress)) return remoteAddress || 'unknown';

  if (remoteAddress === '127.0.0.1') {
    const forwardedAddress = normalizeAddress(request.headers['x-forwarded-for']);
    if (isIP(forwardedAddress)) return forwardedAddress;
  }

  return remoteAddress || 'unknown';
}
