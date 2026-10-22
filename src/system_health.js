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

// Today's incident: CPU pinned at 100% for a long stretch and nothing backed
// off on its own — a human had to notice and click "Hentikan Semua". This
// tracks how long CPU has been *continuously* at/above CPU_CRITICAL_PERCENT
// and flips `throttled` on once that streak crosses CPU_CRITICAL_SUSTAIN_MS,
// so a brief spike (a burst of reconnects, one heavy export) never trips it —
// only genuinely sustained overload does. Recovery uses a lower threshold
// (CPU_RECOVER_PERCENT) than the trip point so it doesn't immediately flap
// back on right at the boundary.
const CPU_CRITICAL_PERCENT = Number(process.env.CPU_CRITICAL_PERCENT) || 90;
const CPU_CRITICAL_SUSTAIN_MS = Number(process.env.CPU_CRITICAL_SUSTAIN_MS) || 60000;
const CPU_RECOVER_PERCENT = Number(process.env.CPU_RECOVER_PERCENT) || 70;
// Recovery needs to be sustained too, symmetric to the trip condition above
// — a single instantaneous low sample (a brief idle gap between encoder
// restarts, a GC pause skewing the delta) used to clear `throttled`
// immediately on its own, letting streaming.js's drainSoftwareQueue() start
// new software encoders right as CPU rockets back to critical a couple
// seconds later — reproducing the exact overload this mechanism exists to
// prevent. Shorter than the trip sustain window on purpose: a real recovery
// should still be noticed reasonably promptly, just not on one lucky sample.
const CPU_RECOVER_SUSTAIN_MS = Number(process.env.CPU_RECOVER_SUSTAIN_MS) || 10000;
let criticalSince = null;
let recoverableSince = null;
let throttled = false;

function updateThrottleState(percent) {
  const now = Date.now();
  if (percent >= CPU_CRITICAL_PERCENT) {
    if (!criticalSince) criticalSince = now;
    recoverableSince = null;
    if (!throttled && now - criticalSince >= CPU_CRITICAL_SUSTAIN_MS) {
      throttled = true;
      console.warn(`[open-vms] CPU >= ${CPU_CRITICAL_PERCENT}% selama >= ${Math.round(CPU_CRITICAL_SUSTAIN_MS / 1000)}s — menahan live view baru sampai beban turun.`);
    }
  } else {
    criticalSince = null;
    if (throttled) {
      if (percent <= CPU_RECOVER_PERCENT) {
        if (!recoverableSince) recoverableSince = now;
        if (now - recoverableSince >= CPU_RECOVER_SUSTAIN_MS) {
          throttled = false;
          recoverableSince = null;
          console.warn(`[open-vms] CPU turun ke ${percent}% selama >= ${Math.round(CPU_RECOVER_SUSTAIN_MS / 1000)}s — melepas penahanan live view baru.`);
        }
      } else {
        recoverableSince = null;
      }
    }
  }
}

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
  updateThrottleState(overall);
}

setInterval(sampleCpu, SAMPLE_INTERVAL_MS).unref();

function isThrottled() {
  return throttled;
}

// Deliberately small/unrestricted-by-role payload — any logged-in user (not
// just admins) needs to know live view is being held back and why, without
// exposing the full per-core/memory breakdown the admin-only /api/system-health
// endpoint returns.
function getThrottleStatus() {
  return {
    throttled,
    cpu_percent: lastCpuPercent.overall,
    critical_percent: CPU_CRITICAL_PERCENT,
  };
}

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
      throttled,
      critical_since: criticalSince ? new Date(criticalSince).toISOString() : null,
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

module.exports = { router, isThrottled, getThrottleStatus };
