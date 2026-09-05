/**
 * POST /api/strava/token
 * Exchanges a Strava OAuth authorization `code` for an access token.
 * The client secret lives only here (server-side env var), never in the browser.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const code = req.body && req.body.code;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientSecret) {
    return res.status(500).json({ error: 'Strava is not configured on the server (missing STRAVA_CLIENT_SECRET).' });
  }

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID || '277115',
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
  });

  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Strava token exchange failed', detail: data });

    // Return only what the client needs (not the refresh token or secret).
    return res.status(200).json({
      access_token: data.access_token,
      expires_at: data.expires_at,
      athlete: data.athlete ? { firstname: data.athlete.firstname, id: data.athlete.id } : null,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Strava', detail: String(err) });
  }
}
