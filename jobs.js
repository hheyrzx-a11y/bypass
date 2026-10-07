"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./config");
const { processVideo } = require("./pipeline");

const jobs = new Map();
const queue = [];
let running = 0;

const rm = file => fs.promises.rm(file, { force: true }).catch(() => {});

/* ---------- estado público + SSE ---------- */

function publicState(job) {
  return {
    id: job.id,
    status: job.status,           // queued | probing | converting | patching | done | error
    percent: Math.round(job.percent * 10) / 10,
    message: job.message,
    error: job.error,
    result: job.result,
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(job, event) {
  const data = publicState(job);
  for (const res of job.listeners) sse(res, event, data);
}

function closeListeners(job) {
  for (const res of job.listeners) res.end();
  job.listeners.clear();
}

function update(job, patch) {
  if (patch.percent !== undefined) patch.percent = Math.max(job.percent, patch.percent);
  Object.assign(job, patch);
  broadcast(job, "progress");
}

function refreshQueueMessages() {
  queue.forEach((job, i) => {
    job.message = `En cola (posición ${i + 1})…`;
    broadcast(job, "progress");
  });
}

/* ---------- ciclo de vida ---------- */

function downloadName(originalName) {
  const base = (originalName || "video").replace(/\.[^/.]+$/, "")
    .replace(/[^\w.-]+/g, "_").slice(0, 80) || "video";
  return `${base}_kayro_hq_patched.mp4`;
}

function create({ id, uploadPath, originalName, size }) {
  const job = {
    id,
    status: "queued",
    percent: 0,
    message: "En cola…",
    error: null,
    result: null,
    originalName,
    inputSize: size,
    paths: {
      upload: uploadPath,
      work: path.join(config.TMP_DIR, `${id}.work.mp4`),
      output: path.join(config.TMP_DIR, `${id}.out.mp4`),
    },
    listeners: new Set(),
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  queue.push(job);
  refreshQueueMessages();
  pump();
  return job;
}

function pump() {
  while (running < config.MAX_CONCURRENT_JOBS && queue.length) {
    const job = queue.shift();
    refreshQueueMessages();
    running++;
    run(job).finally(() => { running--; pump(); });
  }
}

async function run(job) {
  try {
    const res = await processVideo({
      uploadPath: job.paths.upload,
      workPath: job.paths.work,
      outputPath: job.paths.output,
      onProgress: (status, percent, message) => update(job, { status, percent, message }),
    });

    job.status = "done";
    job.percent = 100;
    job.message = "Listo. Tu video está parchado.";
    job.finishedAt = Date.now();
    job.result = {
      filename: downloadName(job.originalName),
      inputBytes: res.inputBytes,
      outputBytes: res.outputBytes,
      addedAvc: res.addedAvc,
      downloadUrl: `/api/jobs/${job.id}/download`,
    };
    broadcast(job, "done");
  } catch (err) {
    if (!err.isUser) console.error(`[job ${job.id}]`, err);
    job.status = "error";
    job.finishedAt = Date.now();
    job.error = {
      code: err.isUser ? err.code : "INTERNAL",
      message: err.isUser ? err.message : "Ocurrió un error procesando el video.",
    };
    job.message = job.error.message;
    await rm(job.paths.output);
    broadcast(job, "error");
  } finally {
    // El original y el intermedio se borran siempre, salga bien o mal.
    await Promise.all([rm(job.paths.upload), rm(job.paths.work)]);
    closeListeners(job);
  }
}

/** Borra todos los archivos del trabajo y lo olvida. */
async function dispose(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  const i = queue.indexOf(job);
  if (i >= 0) queue.splice(i, 1);
  closeListeners(job);
  await Promise.all(Object.values(job.paths).map(rm));
}

/* ---------- limpieza automática ---------- */

async function sweep() {
  const now = Date.now();

  for (const job of [...jobs.values()]) {
    const finishedAge = job.finishedAt ? now - job.finishedAt : 0;
    if (job.status === "done" && finishedAge > config.DONE_TTL_MS) await dispose(job.id);
    else if (job.status === "error" && finishedAge > config.ERROR_TTL_MS) await dispose(job.id);
    else if (!job.finishedAt && now - job.createdAt > config.HARD_CAP_MS) await dispose(job.id);
  }

  // Archivos huérfanos (subidas cortadas, reinicios, etc.)
  try {
    const known = new Set([...jobs.values()].flatMap(j => Object.values(j.paths)));
    for (const name of await fs.promises.readdir(config.TMP_DIR)) {
      const file = path.join(config.TMP_DIR, name);
      if (known.has(file)) continue;
      const st = await fs.promises.stat(file).catch(() => null);
      if (st && now - st.mtimeMs > 30 * 60 * 1000) await rm(file);
    }
  } catch { /* noop */ }
}

function init() {
  fs.rmSync(config.TMP_DIR, { recursive: true, force: true });
  fs.mkdirSync(config.TMP_DIR, { recursive: true });
  setInterval(sweep, 60 * 1000).unref();
}

module.exports = {
  init,
  create,
  dispose,
  get: id => jobs.get(id),
  pendingCount: () => queue.length + running,
  publicState,
  sse,
};
