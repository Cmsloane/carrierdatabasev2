export const config = {
  schedule: '@hourly'
};

export default async () => {
  const baseUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
  if (!baseUrl) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing URL/DEPLOY_PRIME_URL for scheduled Gmail sync.' }, null, 2), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/.netlify/functions/api/gmail/sync`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gmail-sync-secret': process.env.GMAIL_SYNC_SECRET || ''
    },
    body: JSON.stringify({ source: 'netlify_gmail_cron' })
  });

  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
};
