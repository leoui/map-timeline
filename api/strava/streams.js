/**
 * GET /api/strava/streams?id=ACTIVITY_ID
 * Proxies the GPS + time streams for one activity, so the app can rebuild the
 * route with timestamps.
 */
export default async function handler(req, res) {
  const auth = req.headers.authorization;
  const id = req.query.id;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });
  if (!id || !/^\d+$/.test(String(id))) return res.status(400).json({ error: 'Missing or invalid activity id' });

  try {
    const url = `https://www.strava.com/api/v3/activities/${id}/streams?keys=latlng,time,altitude&key_by_type=true`;
    const r = await fetch(url, { headers: { Authorization: auth } });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Strava streams failed', detail: data });
    return res.status(200).json({
      latlng: data.latlng ? data.latlng.data : [],
      time: data.time ? data.time.data : [],
      altitude: data.altitude ? data.altitude.data : [],
    });
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Strava', detail: String(err) });
  }
}
