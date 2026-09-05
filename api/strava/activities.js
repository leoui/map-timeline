/**
 * GET /api/strava/activities
 * Proxies the athlete's recent activities. The browser sends the user's access
 * token in the Authorization header; we forward it (Strava's API does not allow
 * direct browser CORS calls, so this proxy is required).
 */
export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });

  const perPage = Math.min(parseInt(req.query.per_page || '30', 10) || 30, 50);
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1);

  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}&page=${page}`,
      { headers: { Authorization: auth } }
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: 'Strava activities failed', detail: data });

    // Trim to the fields the app uses, to keep the payload small.
    const list = Array.isArray(data)
      ? data.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.sport_type || a.type,
          start_date: a.start_date,
          distance: a.distance,
          moving_time: a.moving_time,
          elapsed_time: a.elapsed_time,
          average_speed: a.average_speed,
          total_elevation_gain: a.total_elevation_gain,
          has_map: !!(a.map && a.map.summary_polyline),
        }))
      : [];
    return res.status(200).json(list);
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Strava', detail: String(err) });
  }
}
