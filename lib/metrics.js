// =========================================================
// OpenWeb — Ressourcenmonitor (nur die App selbst)
// =========================================================
// Sammelt alle SAMPLE_MS einen Messpunkt und haelt die letzte Stunde im Speicher
// (keine Datenbank, keine externen Dienste). Abruf ueber /api/admin/metrics.

const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

const SAMPLE_MS = 10 * 1000;
const HISTORY_SIZE = 360; // 360 x 10 s = 1 Stunde

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
  timer = setInterval(takeSample, SAMPLE_MS);
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

module.exports = { start, middleware, snapshot };
