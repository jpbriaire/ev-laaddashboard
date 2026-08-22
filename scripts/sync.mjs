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

async function getState(entityId) {
  const res = await fetch(`${HA_BASE_URL}/api/states/${entityId}`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
  });
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

async function main() {
  const status = await getState(STATUS_ENTITY);
  if (status.state !== 'Available') {
    console.log(`Status is '${status.state}' — er wordt geladen, geen actie.`);
    return;
  }

  const meter = await getState(METER_ENTITY);
  const currentReading = parseFloat(meter.state);
  if (Number.isNaN(currentReading)) {
    console.log(`Meterstand niet numeriek ('${meter.state}') — geen actie.`);
    return;
  }

  const state = JSON.parse(await readFile('state.json', 'utf8'));
  const now = new Date();
  const lastCheckedAt = new Date(state.lastCheckedAt);
  const delta = currentReading - state.lastMeterReading;

  if (delta > DELTA_THRESHOLD_KWH) {
    const sessions = JSON.parse(await readFile('sessions.json', 'utf8'));
    const { date, time } = amsterdamParts(lastCheckedAt);
    const durationMin = Math.max(0, Math.round((now - lastCheckedAt) / 60000));
    const id = `auto_${date.replace(/-/g, '')}T${time.replace(':', '')}`;
    sessions.push({
      id,
      date,
      time,
      duration: durationMin,
      kwh: Math.round(delta * 100) / 100,
      note: 'Automatisch gelogd (GitHub Actions)',
    });
    await writeFile('sessions.json', JSON.stringify(sessions, null, 2) + '\n');
    console.log(`Nieuwe sessie gelogd: ${delta.toFixed(2)} kWh op ${date} ${time}.`);
  } else {
    console.log(`Geen nieuwe sessie (delta ${delta.toFixed(3)} kWh <= drempel).`);
  }

  await writeFile(
    'state.json',
    JSON.stringify({ entity: METER_ENTITY, lastMeterReading: currentReading, lastCheckedAt: now.toISOString() }, null, 2) + '\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
