export function getAuthContext(req, { allowUnauthenticated }) {
  const emailHeader = req.headers['x-goog-authenticated-user-email'] || req.headers['x-forwarded-email'] || '';
  const idHeader = req.headers['x-goog-authenticated-user-id'] || '';
  const rawEmail = Array.isArray(emailHeader) ? emailHeader[0] : emailHeader;
  const rawId = Array.isArray(idHeader) ? idHeader[0] : idHeader;
  const email = String(rawEmail || '').replace(/^accounts\.google\.com:/, '').trim();
  const userId = String(rawId || '').replace(/^accounts\.google\.com:/, '').trim();

  if (email) {
    return {
      authenticated: true,
      provider: 'google-iap',
      email,
      userId: userId || email
    };
  }

  if (allowUnauthenticated) {
    return {
      authenticated: false,
      provider: 'local-dev',
      email: '',
      userId: 'local-dev'
    };
  }

  return null;
}
