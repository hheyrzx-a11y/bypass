"use strict";

const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const config = require("./config");
const { UserError, probe, assertWithinLimits, toMp4WithAvc } = require("./media");

function patchInWorker(input, output, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "patch-worker.js"), {
      workerData: { input, output, tag: config.TAG_TEXT },
    });
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

    worker.on("message", msg => {
      if (msg.type === "progress") onProgress(msg.value);
      else if (msg.type === "done") settle(resolve, msg);
      else if (msg.type === "error") {
        console.error("[patch]", msg.message);
        settle(reject, new UserError("PATCH_FAILED", "No se pudo aplicar el parche a este video."));
      }
    });
    worker.on("error", err => {
      console.error("[patch]", err);
      settle(reject, new UserError("PATCH_FAILED", "No se pudo aplicar el parche a este video."));
    });
    worker.on("exit", code => {
      if (code !== 0) settle(reject, new UserError("PATCH_FAILED", "El parche se interrumpió (falta de memoria)."));
    });
  });
}

/**
 * 1) Revisa límites (1080p / 120 fps)  2) Se asegura de que tenga H.264/AVC
 * 3) Aplica el parche HQ              4) Escribe la etiqueta
 *
 * onProgress(stage, percent 0-100, message)
 */
async function processVideo({ uploadPath, workPath, outputPath, onProgress }) {
  onProgress("probing", 1, "Revisando el video…");
  const info = await probe(uploadPath);
  assertWithinLimits(info);

  const alreadyAvc = info.video.codec === "h264";
  onProgress(
    "probing", 5,
    alreadyAvc
      ? "H.264/AVC detectado."
      : "No tiene H.264/AVC: se agregará sin perder calidad."
  );

  onProgress("converting", 5, alreadyAvc ? "Preparando el MP4…" : "Agregando H.264/AVC sin pérdida…");
  await toMp4WithAvc({
    input: uploadPath,
    output: workPath,
    info,
    onProgress: p => onProgress("converting", 5 + p * 65, alreadyAvc ? "Preparando el MP4…" : "Agregando H.264/AVC sin pérdida…"),
  });

  const workSize = fs.statSync(workPath).size;
  if (workSize > config.MAX_WORK_BYTES) {
    throw new UserError(
      "TOO_BIG_AFTER_CONVERT",
      "El video resultante es demasiado grande para parcharlo en este servidor. Prueba con un video más corto."
    );
  }

  onProgress("patching", 72, "Aplicando el parche HQ…");
  const res = await patchInWorker(workPath, outputPath, p =>
    onProgress("patching", 72 + p * 26, "Aplicando el parche HQ…")
  );

  return {
    inputBytes: res.inputBytes,
    outputBytes: res.outputBytes,
    addedAvc: !alreadyAvc,
    video: info.video,
  };
}

module.exports = { processVideo };
