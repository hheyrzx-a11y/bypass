"use strict";

const os = require("os");
const path = require("path");

const num = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const MB = 1024 * 1024;

module.exports = {
  PORT: num("PORT", 10000),
  TMP_DIR: process.env.TMP_DIR || path.join(os.tmpdir(), "kayro-patch"),

  // Orígenes permitidos (tu sitio web), separados por coma. Vacío = cualquiera.
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean),

  // Límites del video aceptado
  MAX_LONG_SIDE: 1920,   // 1080p: 1920x1080 (o 1080x1920 vertical)
  MAX_SHORT_SIDE: 1080,
  MAX_FPS: 120,

  // Límites de tamaño
  MAX_UPLOAD_BYTES: num("MAX_UPLOAD_MB", 200) * MB,
  // Tamaño máximo del MP4 intermedio. El parche trabaja en memoria (~2x este valor).
  MAX_WORK_BYTES: num("MAX_WORK_MB", 300) * MB,

  // Cola y tráfico
  MAX_CONCURRENT_JOBS: num("MAX_CONCURRENT_JOBS", 1),
  MAX_QUEUE: num("MAX_QUEUE", 10),
  RATE_LIMIT_WINDOW_MIN: num("RATE_LIMIT_WINDOW_MIN", 15),
  RATE_LIMIT_MAX: num("RATE_LIMIT_MAX", 15),

  // Limpieza automática
  DONE_TTL_MS: num("DONE_TTL_MIN", 15) * 60 * 1000,    // listo pero sin descargar
  ERROR_TTL_MS: num("ERROR_TTL_MIN", 10) * 60 * 1000,
  HARD_CAP_MS: num("JOB_HARD_CAP_MIN", 120) * 60 * 1000,
  PROCESS_TIMEOUT_MS: num("PROCESS_TIMEOUT_MIN", 60) * 60 * 1000,

  // Conversión a H.264 cuando el video no lo trae.
  // Vacío = lossless real (x264 -qp 0). Un número (ej. 8) usa CRF en vez de lossless.
  AVC_CRF: process.env.AVC_CRF ? Number(process.env.AVC_CRF) : null,
  AVC_PRESET: process.env.AVC_PRESET || "veryfast",

  // Etiqueta que se escribe en los metadatos del video de salida
  TAG_TEXT: process.env.TAG_TEXT || "BYPASS BY KAYRO STUDIO",
};
