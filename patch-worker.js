"use strict";

/**
 * Corre en un worker thread para no bloquear el servidor (SSE y otros usuarios)
 * mientras se parcha. Lee el MP4, aplica el parche HQ, escribe la etiqueta y guarda.
 */

const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const KAYRO_STUDIO_HQ = require("./kayro-hq");
const { addTag } = require("./tagger");

function writeAll(fd, bytes) {
  let off = 0;
  while (off < bytes.length) {
    off += fs.writeSync(fd, bytes, off, bytes.length - off);
  }
}

try {
  const { input, output, tag } = workerData;

  const source = fs.readFileSync(input);
  parentPort.postMessage({ type: "progress", value: 0.15 });

  const patched = KAYRO_STUDIO_HQ.patchHQ(source);
  parentPort.postMessage({ type: "progress", value: 0.6 });

  const parts = addTag(patched, tag);
  parentPort.postMessage({ type: "progress", value: 0.75 });

  const fd = fs.openSync(output, "w");
  try {
    for (const part of parts) writeAll(fd, part);
  } finally {
    fs.closeSync(fd);
  }

  parentPort.postMessage({
    type: "done",
    inputBytes: source.byteLength,
    outputBytes: fs.statSync(output).size,
  });
} catch (err) {
  parentPort.postMessage({ type: "error", message: String(err && err.message || err) });
}
