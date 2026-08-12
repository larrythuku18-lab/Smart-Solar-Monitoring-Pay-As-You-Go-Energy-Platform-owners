/**
 * weather-alerts.js — pure builders for the daily "weather + energy tip"
 * alert (SMS + email) that the server.js cron sends to opted-in customers.
 *
 * Kept free of I/O so the builders are trivially unit-testable and the
 * message content lives in one obvious place. The forecast shape is the
 * grouped-day payload from server.js's /api/weather/forecast:
 *   { date, label, minTemp, maxTemp, pop, icon, condition, emoji }
 */

/* Pick an energy tip from tomorrow's forecast. Returns an object with a
   short SMS-safe tip (must fit inside the 160-char single-segment budget)
   and a slightly longer email version. Weather-derived, not AI — the rule
   table is deliberately small and explainable. */
function pickEnergyTip(day) {
  const pop = Number(day?.pop) || 0;
  const condition = String(day?.condition || '').toLowerCase();
  const maxTemp = Number(day?.maxTemp) || 0;

  /* Rain day — the biggest solar killer in East Africa. */
  if (pop >= 40 || condition.includes('rain') || condition.includes('thunder')) {
    return {
      sms:   'Rain likely — expect lower solar output. Conserve power and top up early.',
      email: 'Rain is likely tomorrow, so solar output will be lower than usual. '
           + 'Charge your battery early, delay heavy appliances to sunnier hours, '
           + 'and top up before the clouds arrive if your balance is low.'
    };
  }

  /* Cloudy — partial generation. */
  if (condition.includes('cloud') || pop >= 20) {
    return {
      sms:   'Cloudy — solar will dip. Run heavy appliances midday when the sun peaks.',
      email: 'A cloudy day means moderate solar generation. Schedule washing and '
           + 'other heavy loads for the midday window (10:00–14:00) when the sun '
           + 'breaks through, and keep the fridge/freezer running at a steady setting.'
    };
  }

  /* Hot & clear — panels overheat slightly, but generation is at its best. */
  if (maxTemp >= 30) {
    return {
      sms:   'Hot sunny day — great solar, but cooling loads drain the battery. Plan ahead.',
      email: 'Tomorrow will be hot and clear — excellent solar generation, but air '
           + 'conditioning and fridges work harder in the heat and will drain your '
           + 'battery faster. Run cooling-heavy appliances during peak solar hours '
           + 'and keep your top-up balance healthy.'
    };
  }

  /* Default: clear/mild — the ideal solar day. */
  return {
    sms:   'Clear skies — great solar day! Run heavy appliances 10am–2pm.',
    email: 'Clear skies tomorrow mean strong solar generation. This is the ideal day '
         + 'to run energy-heavy tasks (pumping, washing, charging) between 10:00 and '
         + '14:00, while your battery charges fastest.'
  };
}

/* SMS-safe weather summary line — deliberately compact and ASCII-only.
   NO emoji here: any non-GSM-7 character forces the whole message into
   UCS-2, where a segment holds 70 characters instead of 160 — a 150-char
   message would silently become 3 segments (3× the per-customer cost),
   violating the one-segment discipline documented in sms.js. */
function weatherSummarySms(day, city) {
  const pop = Number(day?.pop) || 0;
  const rain = pop >= 50 ? `${pop}% rain` : pop > 0 ? `${pop}% rain risk` : 'dry';
  return `${city || 'Nairobi'} ${day?.maxTemp}°/${day?.minTemp}°, ${rain}`;
}

/* Full SMS for the daily alert. Target: one 160-char GSM-7 segment. */
function buildWeatherSms({ name, day, city }) {
  const tip = pickEnergyTip(day);
  const who = name ? `Hi ${name}, ` : '';
  return `SolGrid: ${who}Tomorrow ${weatherSummarySms(day, city)}. Tip: ${tip.sms}`;
}

/* Email body for the daily alert — can afford the fuller picture. */
function buildWeatherEmail({ name, day, city, days }) {
  const tip = pickEnergyTip(day);
  const rows = (days || [])
    .slice(0, 3)
    .map(d => `  • ${d.label}: ${d.emoji} ${d.maxTemp}° / ${d.minTemp}° · ${Math.round(d.pop || 0)}% rain`)
    .join('\n');
  return (
`Hi ${name || 'there'},

Here's tomorrow's weather for ${city || 'your area'} and an energy tip to help you get the most from your SolGrid system.

Tomorrow: ${day?.emoji || ''} ${day?.condition || '—'} · ${day?.maxTemp}° / ${day?.minTemp}°C · ${Math.round(day?.pop || 0)}% chance of rain

Energy tip: ${tip.email}

Next few days:
${rows || '  (forecast data unavailable)'}

Manage these alerts anytime from the Account tab in your SolGrid portal.

— SolGrid`);
}

module.exports = { pickEnergyTip, weatherSummarySms, buildWeatherSms, buildWeatherEmail };
