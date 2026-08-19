const os = require('os');
const express = require('express');

const router = express.Router();

// os.cpus() reports cumulative core times since boot, not instantaneous
// load, so a usage % needs a delta between two snapshots. A background
// timer keeps that snapshot rolling so GET requests return instantly
// instead of each one paying a sampling delay — same reasoning as
// healthcheck.js polling cameras on its own schedule rather than on request.
const SAMPLE_INTERVAL_MS = 2000;
let lastCpuTimes = os.cpus().map((c) => c.times);
let lastCpuPercent = { overall: 0, cores: lastCpuTimes.map(() => 0) };

function sampleCpu() {
  const current = os.cpus().map((c) => c.times);
  const cores = current.map((now, i) => {
    const prev = lastCpuTimes[i];
    if (!prev) return 0;
    const prevTotal = prev.user + prev.nice + prev.sys + prev.irq + prev.idle;
    const nowTotal = now.user + now.nice + now.sys + now.irq + now.idle;
    const totalDelta = nowTotal - prevTotal;
    const idleDelta = now.idle - prev.idle;
    return totalDelta > 0 ? Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100))) : 0;
  });
  const overall = cores.length ? Math.round(cores.reduce((a, b) => a + b, 0) / cores.length) : 0;
  lastCpuTimes = current;
  lastCpuPercent = { overall, cores };
}

setInterval(sampleCpu, SAMPLE_INTERVAL_MS).unref();

function getSnapshot() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  return {
    cpu: {
      percent: lastCpuPercent.overall,
      cores: lastCpuPercent.cores,
      core_count: lastCpuPercent.cores.length,
      // os.loadavg() is 1/5/15-min load average; always [0,0,0] on Windows,
      // where there's no OS-level concept of load average.
      load_average: os.loadavg(),
    },
    memory: {
      total_bytes: totalMem,
      free_bytes: freeMem,
      used_bytes: usedMem,
      percent: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
    },
    process: {
      rss_bytes: process.memoryUsage().rss,
      uptime_seconds: Math.floor(process.uptime()),
    },
    system: {
      uptime_seconds: Math.floor(os.uptime()),
      platform: os.platform(),
      hostname: os.hostname(),
    },
    sampled_at: new Date().toISOString(),
  };
}

router.get('/', (req, res) => {
  res.json(getSnapshot());
});

module.exports = router;
