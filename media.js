"use strict";

const { spawn } = require("child_process");
const config = require("./config");

/** Error con mensaje seguro para mostrar al usuario. */
class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.isUser = true;
  }
}

function run(cmd, args, { onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let buf = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new UserError("TIMEOUT", "El procesamiento tardó demasiado y se canceló."));
    }, config.PROCESS_TIMEOUT_MS);

    child.stdout.on("data", chunk => {
      if (onStdoutLine) {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          onStdoutLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseRate(str) {
  if (!str || typeof str !== "string") return 0;
  const [n, d] = str.split("/").map(Number);
  if (!Number.isFinite(n)) return 0;
  if (d === undefined) return n;
  return d > 0 ? n / d : 0;
}

async function probe(file) {
  const { code, stdout } = await run("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ]);
  if (code !== 0) {
    throw new UserError("UNREADABLE", "No se pudo leer el archivo. ¿Es realmente un video?");
  }

  let json;
  try { json = JSON.parse(stdout); } catch {
    throw new UserError("UNREADABLE", "No se pudo leer el archivo.");
  }

  const streams = json.streams || [];
  const v = streams.find(s => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) throw new UserError("NO_VIDEO", "El archivo no contiene una pista de video.");

  const duration = Number(v.duration) || Number(json.format?.duration) || 0;

  let fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate);
  if (!fps && Number(v.nb_frames) > 0 && duration > 0) fps = Number(v.nb_frames) / duration;

  return {
    container: json.format?.format_name || "",
    duration,
    video: {
      codec: v.codec_name,
      width: Number(v.width) || 0,
      height: Number(v.height) || 0,
      fps,
      pixFmt: v.pix_fmt,
    },
    hasAudio: streams.some(s => s.codec_type === "audio"),
  };
}

/** Acepta solo hasta 1080p y 120 fps. */
function assertWithinLimits(info) {
  const { width, height, fps } = info.video;
  const long = Math.max(width, height);
  const short = Math.min(width, height);

  if (!width || !height) {
    throw new UserError("NO_RESOLUTION", "No se pudo determinar la resolución del video.");
  }
  if (long > config.MAX_LONG_SIDE || short > config.MAX_SHORT_SIDE) {
    throw new UserError(
      "RESOLUTION_TOO_HIGH",
      `El video es de ${width}x${height}. Solo se aceptan videos de hasta 1080p (1920x1080).`
    );
  }
  if (!fps) {
    throw new UserError("NO_FPS", "No se pudo determinar los fps del video.");
  }
  if (fps > config.MAX_FPS + 0.5) {
    throw new UserError(
      "FPS_TOO_HIGH",
      `El video es de ${Math.round(fps)} fps. Solo se aceptan videos de hasta ${config.MAX_FPS} fps.`
    );
  }
}

async function ffmpegWithProgress(args, durationSec, onProgress) {
  const full = [
    "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-progress", "pipe:1", "-nostats", ...args,
  ];
  const result = await run("ffmpeg", full, {
    onStdoutLine: line => {
      const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line);
      if (m && durationSec > 0) {
        onProgress(Math.min(Number(m[1]) / 1e6 / durationSec, 1));
      }
    },
  });
  return result;
}

/**
 * Deja un MP4 limpio (un solo mdat, sin fragmentos) con video H.264/AVC.
 * - Si ya es H.264: copia el stream tal cual (cero pérdida, no se recodifica).
 * - Si no: lo recodifica a H.264 sin pérdida (x264 -qp 0) o con CRF si AVC_CRF está definido.
 * Audio: se copia tal cual; solo si el MP4 no lo admite se pasa a AAC 320k.
 */
async function toMp4WithAvc({ input, output, info, onProgress }) {
  const alreadyAvc = info.video.codec === "h264";

  const videoArgs = alreadyAvc
    ? ["-c:v", "copy"]
    : [
        "-c:v", "libx264",
        ...(config.AVC_CRF !== null ? ["-crf", String(config.AVC_CRF)] : ["-qp", "0"]),
        "-preset", config.AVC_PRESET,
        "-fps_mode", "passthrough",
      ];

  const build = audioArgs => [
    "-i", input,
    "-map", "0:v:0", "-map", "0:a:0?",
    ...videoArgs,
    ...audioArgs,
    "-sn", "-dn",
    "-map_metadata", "-1",
    "-f", "mp4",
    output,
  ];

  let r = await ffmpegWithProgress(build(["-c:a", "copy"]), info.duration, onProgress);

  if (r.code !== 0 && info.hasAudio) {
    // El audio original no cabe en MP4: único caso donde se recodifica el audio.
    r = await ffmpegWithProgress(build(["-c:a", "aac", "-b:a", "320k"]), info.duration, onProgress);
  }
  if (r.code !== 0) {
    console.error("[ffmpeg]", r.stderr);
    throw new UserError("CONVERT_FAILED", "No se pudo convertir el video a MP4/H.264.");
  }

  return { alreadyAvc };
}

module.exports = { UserError, probe, assertWithinLimits, toMp4WithAvc };
