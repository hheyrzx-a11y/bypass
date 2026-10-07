"use strict";

/**
 * Escribe la etiqueta en los metadatos (moov/udta/meta/ilst: título y comentario)
 * DESPUÉS del parche, sin tocar el video, y corrige los offsets de los chunks
 * (stco/co64) porque el moov crece y el mdat se desplaza.
 *
 * Se hace aquí y no con ffmpeg porque ffmpeg reescribiría el contenedor
 * y desharía el parche.
 */

const CONTAINERS = new Set(["trak", "mdia", "minf", "stbl"]);

const read32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const write32 = (b, p, v) => {
  b[p] = (v >>> 24) & 255; b[p + 1] = (v >>> 16) & 255; b[p + 2] = (v >>> 8) & 255; b[p + 3] = v & 255;
};
const type4 = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function box(type, ...payload) {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  write32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

const ascii = s => Uint8Array.from(Buffer.from(s, "latin1"));
const zeros = n => new Uint8Array(n);

function ilstText(type, text) {
  const data = box("data", Uint8Array.from([0, 0, 0, 1]), zeros(4), Uint8Array.from(Buffer.from(text, "utf8")));
  return box(type, data);
}

function buildUdta(text) {
  const hdlr = box("hdlr", zeros(4), zeros(4), ascii("mdir"), ascii("appl"), zeros(8), zeros(1));
  const ilst = box("ilst", ilstText("\u00a9nam", text), ilstText("\u00a9cmt", text));
  const meta = box("meta", zeros(4), hdlr, ilst);
  return box("udta", meta);
}

function topLevel(buf) {
  const list = [];
  let p = 0;
  while (p + 8 <= buf.length) {
    let size = read32(buf, p);
    let header = 8;
    if (size === 1) {
      size = Number((BigInt(read32(buf, p + 8)) << 32n) | BigInt(read32(buf, p + 12)));
      header = 16;
    } else if (size === 0) {
      size = buf.length - p;
    }
    if (size < header || p + size > buf.length) break;
    list.push({ type: type4(buf, p + 4), start: p, end: p + size, header });
    p += size;
  }
  return list;
}

function shiftOffsets(b, start, end, delta) {
  let p = start;
  while (p + 8 <= end) {
    const size = read32(b, p);
    const type = type4(b, p + 4);
    if (size < 8 || p + size > end) break;

    if (CONTAINERS.has(type)) {
      shiftOffsets(b, p + 8, p + size, delta);
    } else if (type === "stco") {
      const count = read32(b, p + 12);
      for (let i = 0, q = p + 16; i < count; i++, q += 4) {
        const v = read32(b, q) + delta;
        if (v > 0xffffffff) throw new Error("Offset stco fuera de rango (archivo demasiado grande).");
        write32(b, q, v);
      }
    } else if (type === "co64") {
      const count = read32(b, p + 12);
      for (let i = 0, q = p + 16; i < count; i++, q += 8) {
        const v = ((BigInt(read32(b, q)) << 32n) | BigInt(read32(b, q + 4))) + BigInt(delta);
        write32(b, q, Number((v >> 32n) & 0xffffffffn));
        write32(b, q + 4, Number(v & 0xffffffffn));
      }
    }
    p += size;
  }
}

/**
 * Devuelve las partes del archivo final (en orden) para escribirlas sin hacer otra copia grande.
 * @param {Uint8Array} buf  MP4 ya parchado (ftyp, moov, mdat, ...)
 */
function addTag(buf, text) {
  const top = topLevel(buf);
  const moov = top.find(b => b.type === "moov");
  const mdat = top.find(b => b.type === "mdat");

  if (!moov || !mdat) throw new Error("No se encontró moov/mdat para etiquetar.");
  if (moov.start > mdat.start) throw new Error("El moov debe ir antes del mdat para etiquetar.");
  if (moov.header !== 8) throw new Error("moov con cabecera de 64 bits no soportado.");

  const udta = buildUdta(text);

  const newMoov = new Uint8Array(buf.subarray(moov.start, moov.end)); // copia pequeña
  shiftOffsets(newMoov, 8, newMoov.length, udta.length);
  write32(newMoov, 0, newMoov.length + udta.length);

  return [buf.subarray(0, moov.start), newMoov, udta, buf.subarray(moov.end)];
}

module.exports = { addTag, buildUdta };
