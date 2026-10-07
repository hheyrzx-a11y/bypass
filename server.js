"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const config = require("./src/config");
const jobs = require("./src/jobs");

jobs.init();

const app = express();
app.set("trust proxy", 1); // Render va detrás de un proxy
app.disable("x-powered-by");

app.use(cors({
  origin: config.ALLOWED_ORIGINS.length ? config.ALLOWED_ORIGINS : true,
  exposedHeaders: ["Content-Disposition", "Content-Length"],
}));

const fail = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

/* ---------------- Subida ---------------- */

const VIDEO_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|ts|mts|m2ts|3gp|flv|wmv|mpg|mpeg)$/i;

const receiveVideo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.TMP_DIR),
    filename: (req, file, cb) => cb(null, `${req.jobId}.upload`),
  }),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/") || VIDEO_EXT.test(file.originalname)) {
      return cb(null, true);
    }
    const err = new Error("Tipo de archivo no permitido");
    err.code = "INVALID_TYPE";
    cb(err);
  },
}).single("video");

const uploadLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MIN * 60 * 1000,
  limit: config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT", message: "Demasiados videos seguidos. Intenta de nuevo en unos minutos." } },
});

/* ---------------- API ---------------- */

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/limits", (req, res) => {
  res.json({
    maxResolution: "1920x1080",
    maxFps: config.MAX_FPS,
    maxUploadMB: Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024),
  });
});

// 1) Subir el video. Responde en cuanto termina la subida; el procesamiento sigue en segundo plano.
app.post("/api/jobs", uploadLimiter, (req, res) => {
  if (jobs.pendingCount() >= config.MAX_QUEUE) {
    return fail(res, 503, "BUSY", "El servidor está ocupado. Intenta de nuevo en un momento.");
  }

  req.jobId = crypto.randomUUID();

  receiveVideo(req, res, err => {
    if (err) {
      fs.rm(path.join(config.TMP_DIR, `${req.jobId}.upload`), { force: true }, () => {});
      if (err.code === "LIMIT_FILE_SIZE") {
        const mb = Math.round(config.MAX_UPLOAD_BYTES / 1024 / 1024);
        return fail(res, 413, "FILE_TOO_BIG", `El archivo supera el máximo de ${mb} MB.`);
      }
      if (err.code === "INVALID_TYPE") {
        return fail(res, 415, "INVALID_TYPE", "Solo se aceptan archivos de video.");
      }
      if (err.code === "LIMIT_UNEXPECTED_FILE") {
        return fail(res, 400, "BAD_FIELD", 'Envía el archivo en el campo "video".');
      }
      console.error("[upload]", err.message);
      return fail(res, 400, "UPLOAD_FAILED", "La subida falló o se interrumpió.");
    }

    if (!req.file) return fail(res, 400, "NO_FILE", 'Falta el archivo (campo "video").');

    const job = jobs.create({
      id: req.jobId,
      uploadPath: req.file.path,
      originalName: req.file.originalname,
      size: req.file.size,
    });

    res.status(202).json({
      jobId: job.id,
      eventsUrl: `/api/jobs/${job.id}/events`,
      statusUrl: `/api/jobs/${job.id}`,
      downloadUrl: `/api/jobs/${job.id}/download`,
    });
  });
});

// 2a) Progreso en tiempo real (Server-Sent Events)
app.get("/api/jobs/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return fail(res, 404, "NOT_FOUND", "Ese trabajo no existe o ya fue entregado.");

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 2000\n\n");

  // Estado actual al conectar (por si ya avanzó o terminó)
  const event = job.status === "done" ? "done" : job.status === "error" ? "error" : "progress";
  jobs.sse(res, event, jobs.publicState(job));
  if (event !== "progress") return res.end();

  job.listeners.add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    job.listeners.delete(res);
  });
});

// 2b) Alternativa sin SSE: consultar el estado
app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return fail(res, 404, "NOT_FOUND", "Ese trabajo no existe o ya fue entregado.");
  res.json(jobs.publicState(job));
});

// 3) Descargar. Al terminar la descarga, TODO se borra del servidor.
app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return fail(res, 404, "NOT_FOUND", "Ese video ya fue entregado o expiró.");
  if (job.status !== "done") return fail(res, 409, "NOT_READY", "El video todavía se está procesando.");
  if (job.downloading) return fail(res, 409, "IN_PROGRESS", "La descarga ya está en curso.");

  fs.stat(job.paths.output, (err, st) => {
    if (err) {
      jobs.dispose(job.id);
      return fail(res, 410, "GONE", "El archivo ya no está disponible.");
    }

    job.downloading = true;
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": st.size,
      "Content-Disposition": `attachment; filename="${job.result.filename}"`,
      "Cache-Control": "no-store",
    });

    const stream = fs.createReadStream(job.paths.output);
    stream.on("error", () => res.destroy());
    stream.pipe(res);

    res.on("close", () => {
      if (res.writableFinished) {
        jobs.dispose(job.id);        // entregado → borrar
      } else {
        job.downloading = false;     // se cortó → puede reintentar hasta que expire
        stream.destroy();
      }
    });
  });
});

/* ---------------- Página de demo ---------------- */

app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  fail(res, 500, "INTERNAL", "Error interno del servidor.");
});

const server = app.listen(config.PORT, "0.0.0.0", () => {
  console.log(`Kayro patch API escuchando en :${config.PORT}`);
});
server.requestTimeout = 30 * 60 * 1000; // permitir subidas largas
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
});
