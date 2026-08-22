import { readFile, writeFile } from 'node:fs/promises';

const HA_BASE_URL = process.env.HA_BASE_URL;
const HA_TOKEN = process.env.HA_TOKEN;

const STATUS_ENTITY = 'sensor.alfen_eve_single_s_line_status_code_socket_1';
const METER_ENTITY = 'sensor.alfen_eve_single_s_line_meter_reading_socket_1';
const DELTA_THRESHOLD_KWH = 0.05;

if (!HA_BASE_URL || !HA_TOKEN) {
  console.error('HA_BASE_URL en/of HA_TOKEN ontbreken.');
  process.exit(1);
}

function authHeaders() {
  return { Authorization: `Bearer ${HA_TOKEN}` };
}

// Haalt de volledige toestandsgeschiedenis van een entity op tussen twee tijdstippen,
// zodat sessies die binnen één sync-interval starten én eindigen niet gemist worden,
// en een sync die een tijd heeft stilgelegen alsnog de losse sessies kan reconstrueren
// in plaats van alles als één grove blok te loggen.
async function getHistory(entityId, startIso, endIso) {
  const url = `${HA_BASE_URL}/api/history/period/${encodeURIComponent(startIso)}?filter_entity_id=${entityId}&end_time=${encodeURIComponent(endIso)}&minimal_response`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HA history request faalde voor ${entityId}: ${res.status}`);
  const data = await res.json();
  return (data[0] || []).map((p) => ({ time: new Date(p.last_changed), state: p.state }));
}

async function getCurrentState(entityId) {
  const res = await fetch(`${HA_BASE_URL}/api/states/${entityId}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HA request faalde voor ${entityId}: ${res.status}`);
  return res.json();
}

function amsterdamParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

// Meterstand op of vlak voor het gegeven tijdstip, uit de opgehaalde geschiedenis.
function meterAt(meterHistory, time, fallback) {
  let value = fallback;
  for (const p of meterHistory) {
    if (p.time > time) break;
    const n = parseFloat(p.state);
    if (!Number.isNaN(n)) value = n;
  }
  return value;
}

async function main() {
  const state = JSON.parse(await readFile('state.json', 'utf8'));
  const since = new Date(state.lastCheckedAt);
  const now = new Date();

  const [statusHistory, meterHistory] = await Promise.all([
    getHistory(STATUS_ENTITY, since.toISOString(), now.toISOString()),
    getHistory(METER_ENTITY, since.toISOString(), now.toISOString()),
  ]);

  // Reconstrueer de statusovergangen sinds de vorige check (die altijd eindigde op "Available").
  const transitions = [{ time: since, state: 'Available' }, ...statusHistory];

  const closedSessions = [];
  let openChargeStart = null;
  for (const { time, state: s } of transitions) {
    if (s !== 'Available') {
      if (openChargeStart === null) openChargeStart = time;
    } else if (openChargeStart !== null) {
      closedSessions.push({ start: openChargeStart, end: time });
      openChargeStart = null;
    }
  }

  // Schuif lastCheckedAt alleen op tot het einde van de laatst afgesloten sessie
  // (of tot nu, als alles is afgerond) — nooit voorbij een nog lopende sessie.
  const safeUpTo = openChargeStart !== null
    ? (closedSessions.length ? closedSessions[closedSessions.length - 1].end : since)
    : now;

  if (closedSessions.length === 0) {
    console.log(openChargeStart !== null ? 'Sessie loopt nog, nog niets afgerond.' : 'Geen nieuwe sessie.');
  } else {
    const sessions = JSON.parse(await readFile('sessions.json', 'utf8'));
    const existingIds = new Set(sessions.map((s) => s.id));
    const current = await getCurrentState(METER_ENTITY);
    const currentReading = parseFloat(current.state);
    const fallbackMeter = Number.isNaN(currentReading) ? state.lastMeterReading : currentReading;

    for (const { start, end } of closedSessions) {
      const before = meterAt(meterHistory, start, state.lastMeterReading);
      const after = meterAt(meterHistory, end, fallbackMeter);
      const kwh = Math.round((after - before) * 100) / 100;
      if (kwh <= DELTA_THRESHOLD_KWH) continue;
      const { date, time } = amsterdamParts(start);
      const id = `auto_${date.replace(/-/g, '')}T${time.replace(':', '')}`;
      if (existingIds.has(id)) continue;
      const durationMin = Math.max(0, Math.round((end - start) / 60000));
      sessions.push({ id, date, time, duration: durationMin, kwh, note: 'Automatisch gelogd (GitHub Actions)' });
      existingIds.add(id);
      console.log(`Nieuwe sessie gelogd: ${kwh.toFixed(2)} kWh op ${date} ${time}.`);
    }
    await writeFile('sessions.json', JSON.stringify(sessions, null, 2) + '\n');
  }

  const meterAtSafe = meterAt(meterHistory, safeUpTo, state.lastMeterReading);
  await writeFile(
    'state.json',
    JSON.stringify({ entity: METER_ENTITY, lastMeterReading: meterAtSafe, lastCheckedAt: safeUpTo.toISOString() }, null, 2) + '\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
