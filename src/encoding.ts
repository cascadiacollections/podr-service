/**
 * Decode a base64url-encoded URL path segment.
 *
 * The Android client URL-safe-base64-encodes feed and subscription URIs so
 * they can ride in the path without further escaping. Returns null when the
 * input is not valid base64url or does not decode to a syntactically valid
 * absolute URL.
 */
export function decodeBase64UrlToUrl(encoded: string): string | null {
  if (!encoded) return null;
  // base64url → base64
  let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad !== 0) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf-8');
  } catch {
    return null;
  }
  try {
    const u = new URL(decoded);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function encodeUrlToBase64Url(url: string): string {
  return Buffer.from(url, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
