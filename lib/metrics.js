// =========================================================
// OpenWeb — Ressourcenmonitor (nur die App selbst)
// =========================================================
// Sammelt alle SAMPLE_MS einen Messpunkt, haelt die letzte Stunde im Speicher
// und persistiert Messpunkte in PostgreSQL. Abruf ueber /api/admin/metrics.

const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

const SAMPLE_MS = 10 * 1000;
const HISTORY_SIZE = 360; // 360 x 10 s = 1 Stunde
const RETENTION_DAYS = 30;

const history = [];
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();

// Zaehler fuer das aktuelle Intervall (werden bei jedem Messpunkt zurueckgesetzt)
let interval = { requests: 0, errors: 0, durations: [] };
const totals = { requests: 0, errors: 0 };

let lastCpu = process.cpuUsage();
let lastHr = process.hrtime.bigint();
let timer = null;
let pool = null;
let persistInFlight = false;
let lastPersistWarningAt = 0;

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function takeSample() {
  const now = process.hrtime.bigint();
  const elapsedUs = Number(now - lastHr) / 1000;
  const cpu = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  lastHr = now;
  // CPU-Zeit des Prozesses relativ zur Wandzeit, auf einen Kern bezogen (100 % = ein Kern voll)
  const cpuPercent = elapsedUs > 0 ? ((cpu.user + cpu.system) / elapsedUs) * 100 : 0;

  const mem = process.memoryUsage();
  const durations = interval.durations.sort((a, b) => a - b);
  const seconds = SAMPLE_MS / 1000;

  const sample = {
    t: Date.now(),
    cpu: round(cpuPercent),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    loopMeanMs: round(loopDelay.mean / 1e6, 2),
    loopP99Ms: round(loopDelay.percentile(99) / 1e6, 2),
    reqPerMin: round((interval.requests / seconds) * 60),
    errPerMin: round((interval.errors / seconds) * 60),
    requestCount: interval.requests,
    errorCount: interval.errors,
    respAvgMs: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    respP95Ms: round(percentile(durations, 95)),
    dbTotal: pool ? pool.totalCount : 0,
    dbIdle: pool ? pool.idleCount : 0,
    dbWaiting: pool ? pool.waitingCount : 0,
  };

  loopDelay.reset();
  interval = { requests: 0, errors: 0, durations: [] };
  history.push(sample);
  if (history.length > HISTORY_SIZE) history.shift();
  return sample;
}

async function persistSample(sample) {
  if (!pool || persistInFlight) return;
  persistInFlight = true;
  try {
    await pool.query(`
      WITH inserted AS (
        INSERT INTO resource_monitor_samples (
          sampled_at, cpu_percent, rss_bytes, heap_used_bytes, heap_total_bytes,
          loop_mean_ms, loop_p99_ms, requests_per_min, errors_per_min,
          response_avg_ms, response_p95_ms, db_total, db_idle, db_waiting,
          request_count, error_count
        )
        VALUES (
          to_timestamp($1::double precision / 1000.0), $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
        RETURNING request_count, error_count
      )
      INSERT INTO resource_monitor_totals (id, total_requests, total_errors, updated_at)
      SELECT 1, request_count, error_count, NOW() FROM inserted
      ON CONFLICT (id) DO UPDATE SET
        total_requests = resource_monitor_totals.total_requests + EXCLUDED.total_requests,
        total_errors = resource_monitor_totals.total_errors + EXCLUDED.total_errors,
        updated_at = NOW()
    `, [
      sample.t,
      sample.cpu,
      sample.rss,
      sample.heapUsed,
      sample.heapTotal,
      sample.loopMeanMs,
      sample.loopP99Ms,
      sample.reqPerMin,
      sample.errPerMin,
      sample.respAvgMs,
      sample.respP95Ms,
      sample.dbTotal,
      sample.dbIdle,
      sample.dbWaiting,
      sample.requestCount,
      sample.errorCount,
    ]);
  } catch (err) {
    if (Date.now() - lastPersistWarningAt >= 60_000) {
      lastPersistWarningAt = Date.now();
      console.warn('[metrics] Messpunkt konnte nicht gespeichert werden:', err.message);
    }
  } finally {
    persistInFlight = false;
  }
}

async function persistentSnapshot(sinceTs = 0) {
  if (!pool) {
    const current = snapshot(sinceTs);
    return { history: current.history, totals: current.totals };
  }

  const hourStart = Date.now() - HISTORY_SIZE * SAMPLE_MS;
  const requestedSince = Number(sinceTs) || 0;
  const from = new Date(requestedSince > hourStart ? requestedSince : hourStart);
  const [historyResult, totalsResult] = await Promise.all([
    pool.query(`
      SELECT sampled_at, cpu_percent, rss_bytes, heap_used_bytes, heap_total_bytes,
             loop_mean_ms, loop_p99_ms, requests_per_min, errors_per_min,
             response_avg_ms, response_p95_ms, db_total, db_idle, db_waiting,
             request_count, error_count
      FROM resource_monitor_samples
      WHERE sampled_at > $1
      ORDER BY sampled_at ASC
      LIMIT $2
    `, [from, HISTORY_SIZE]),
    pool.query(`
      SELECT total_requests AS requests, total_errors AS errors
      FROM resource_monitor_totals
      WHERE id = 1
      LIMIT 1
    `),
  ]);

  const history = historyResult.rows.map((row) => ({
    t: new Date(row.sampled_at).getTime(),
    cpu: Number(row.cpu_percent),
    rss: Number(row.rss_bytes),
    heapUsed: Number(row.heap_used_bytes),
    heapTotal: Number(row.heap_total_bytes),
    loopMeanMs: Number(row.loop_mean_ms),
    loopP99Ms: Number(row.loop_p99_ms),
    reqPerMin: Number(row.requests_per_min),
    errPerMin: Number(row.errors_per_min),
    respAvgMs: Number(row.response_avg_ms),
    respP95Ms: Number(row.response_p95_ms),
    dbTotal: row.db_total,
    dbIdle: row.db_idle,
    dbWaiting: row.db_waiting,
    requestCount: row.request_count,
    errorCount: row.error_count,
  }));
  const totals = totalsResult.rows[0]
    ? { requests: Number(totalsResult.rows[0].requests), errors: Number(totalsResult.rows[0].errors) }
    : { requests: 0, errors: 0 };

  return { history, totals };
}

// Express-Middleware: zaehlt Anfragen, Fehler (5xx) und Antwortzeiten
function middleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    interval.requests += 1;
    totals.requests += 1;
    if (res.statusCode >= 500) {
      interval.errors += 1;
      totals.errors += 1;
    }
    // Speicher begrenzen: bei sehr vielen Anfragen nur eine Stichprobe behalten
    if (interval.durations.length < 5000) interval.durations.push(ms);
  });
  next();
}

function start(dbPool) {
  pool = dbPool || null;
  if (timer) return;
  // Nur die Basis setzen: ein Messpunkt direkt beim Start wuerde die CPU-Zeit des
  // Hochfahrens (Migrationen usw.) enthalten und die Diagramm-Skala verzerren
  lastCpu = process.cpuUsage();
  lastHr = process.hrtime.bigint();
  loopDelay.reset();
  interval = { requests: 0, errors: 0, durations: [] };
  timer = setInterval(() => {
    const sample = takeSample();
    persistSample(sample);
  }, SAMPLE_MS);
  timer.unref();
}

function snapshot(sinceTs = 0) {
  const mem = process.memoryUsage();
  return {
    sampleMs: SAMPLE_MS,
    process: {
      pid: process.pid,
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      uptimeSec: Math.round(process.uptime()),
      cpuCores: os.cpus().length,
      systemMemTotal: os.totalmem(),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      heapLimit: require('v8').getHeapStatistics().heap_size_limit,
    },
    totals: { ...totals },
    history: sinceTs ? history.filter((s) => s.t > sinceTs) : history.slice(),
  };
}

module.exports = { start, middleware, snapshot, persistentSnapshot, RETENTION_DAYS };
