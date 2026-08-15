/**
 * geocode.js — free, keyless geocoding for per-site weather.
 *
 * Converts a device's free-text location ("Kisumu, Kenya") into lat/lon
 * using Open-Meteo's geocoding API (same provider as the current-conditions
 * feed, so no new accounts or keys). Results are cached for 7 days — city
 * coordinates essentially never move, and this keeps the digest from
 * re-geocoding every recipient every evening.
 *
 * Resolution precedence when picking weather coordinates for a device:
 *   1. exact site coords (devices.lat/lon — set by an installer)
 *   2. geocoded devices.location (free-text city/region)
 *   3. WEATHER_LAT/WEATHER_LON default (env, currently Nairobi)
 */

const axios = require('axios');

const GEO_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (positive results)
const GEO_NEG_TTL_MS = 60 * 60 * 1000;      // 1 hour (failed lookups)
const cache = new Map(); // location(lowercased) -> { at, coords|null }

/* Geocode a free-text location string to { lat, lon, city }. Returns null
   when the string is empty or the upstream has no match. Never throws —
   callers fall back down the resolution chain. */
async function geocodeLocation(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;

  const hit = cache.get(key);
  if (hit) {
    /* Positive results live 7 days (city coords never move); failed lookups
       only 1 hour so a transient upstream blip can't pin a week of
       "unresolvable" — the comment below used to claim this without doing it. */
    const ttl = hit.coords ? GEO_TTL_MS : GEO_NEG_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.coords;
  }

  try {
    const { data } = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
      params: { name: key, count: 1, language: 'en', format: 'json' },
      timeout: 6000
    });
    const r = data?.results?.[0];
    const coords = (r?.latitude != null && r?.longitude != null)
      ? { lat: Number(r.latitude), lon: Number(r.longitude), city: r.name || key }
      : null;
    cache.set(key, { at: Date.now(), coords });
    return coords;
  } catch (err) {
    console.warn('[Geocode] lookup failed for', JSON.stringify(key), ':', err.code || err.message);
    /* Negative-cache failures briefly so a flaky upstream doesn't cause a
       fresh lookup on every request, but not for the full 7 days — a
       transient outage shouldn't pin a stale negative result. */
    cache.set(key, { at: Date.now(), coords: null });
    return null;
  }
}

/* Resolve which coordinates to fetch weather for, given a device row's
   position fields. Precedence: exact lat/lon > geocoded location > default.
   Returns { lat, lon, source: 'exact'|'geocode'|'default', city? }. */
async function resolveWeatherCoords({ lat, lon, location, defaultLat, defaultLon }) {
  if (lat != null && lon != null) {
    return { lat: Number(lat), lon: Number(lon), source: 'exact' };
  }
  if (location) {
    const g = await geocodeLocation(location);
    if (g) return { ...g, source: 'geocode' };
  }
  return { lat: Number(defaultLat), lon: Number(defaultLon), source: 'default' };
}

module.exports = { geocodeLocation, resolveWeatherCoords };
