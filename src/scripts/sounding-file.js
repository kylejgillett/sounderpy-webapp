// Reads an uploaded sounding file (SHARPpy or CM1 input) in the browser. Only the numbers and any
// header site and time go on to the server, which checks them again; the file itself never leaves this page.

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_LEVELS = 10000;
export const MAX_CM1_LEVELS = 2000;
export const FILE_EXTENSIONS = [".txt", ".sharppy", ".snd"];

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const MISSING = -9999;
const NOT_SHARPPY = "This doesn't look like a SHARPpy file. It needs %TITLE%, %RAW% and %END% lines, with six comma-separated columns between %RAW% and %END%.";
const NOT_A_SOUNDING = "This doesn't look like a SHARPpy or CM1 sounding file.";

// Anything that isn't plain text, such as an image or a program renamed to .txt, fails here.
export function decodeText(bytes) {
  if (bytes.some((b) => b < 9 || (b > 13 && b < 32) || b === 127)) throw new Error("This file isn't plain text, so it can't be a sounding file.");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("This file isn't plain text, so it can't be a sounding file.");
  }
}

// { site, date: "2026-10-30", time: "12:00", rows: [[p, z, T, Td, wd, ws], …], skipped }
export function parseSharppy(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((line) => line.trim());
  const title = lines.indexOf("%TITLE%"), raw = lines.indexOf("%RAW%"), end = lines.indexOf("%END%");
  if (title < 0 || raw < title || end < raw) throw new Error(NOT_SHARPPY);
  if (lines.slice(end + 1).some(Boolean)) throw new Error("There's extra text after the %END% line. A SHARPpy file holds one sounding.");
  if (end - raw - 1 > MAX_LEVELS) throw new Error(`This file has more than ${MAX_LEVELS.toLocaleString("en-US")} levels.`);

  const rows = [];
  let skipped = 0;
  for (let i = raw + 1; i < end; i++) {
    if (!lines[i]) continue;
    const fields = lines[i].split(",").map((field) => field.trim());
    if (fields.length !== 6 || !fields.every((field) => NUMBER.test(field))) {
      throw new Error(`Line ${i + 1} isn't valid: each level needs six comma-separated numbers (pressure, height, temperature, dewpoint, wind direction, wind speed).`);
    }
    const row = fields.map(Number);
    if (row.includes(MISSING)) skipped++;
    else rows.push(row);
  }
  if (!rows.length) throw new Error("This file has no complete levels between %RAW% and %END%.");

  // The header line reads "OAX   261030/1200"; both parts are optional.
  const [site = "", stamp = ""] = (lines[title + 1] ?? "").split(/\s+/);
  const when = /^(\d{2})(\d{2})(\d{2})\/(\d{2})(\d{2})$/.exec(stamp);
  return {
    format: "sharppy",
    site: /^[\w.-]{1,60}$/.test(site) ? site : "",
    date: when ? `20${when[1]}-${when[2]}-${when[3]}` : "",
    time: when ? `${when[4]}:${when[5]}` : "",
    rows,
    skipped,
  };
}

// { surface: [pressure, theta, qv], rows: [[z, theta, qv, u, v], …], site: "", date: "", time: "", skipped: 0 }
export function parseCm1(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
  const numbers = (line, count, at) => {
    const fields = line.split(/\s+/);
    if (fields.length !== count || !fields.every((field) => NUMBER.test(field))) throw new Error(at);
    return fields.map(Number);
  };

  const first = lines.findIndex(Boolean);
  if (first < 0) throw new Error("This file is empty.");
  const surface = numbers(lines[first], 3, NOT_A_SOUNDING);
  const levels = lines.slice(first + 1).filter(Boolean).length;
  if (levels > MAX_CM1_LEVELS) throw new Error(`This file has more than ${MAX_CM1_LEVELS.toLocaleString("en-US")} levels.`);

  const rows = [];
  for (let i = first + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    rows.push(numbers(lines[i], 5, `Line ${i + 1} isn't valid: each CM1 level needs five numbers (height, potential temperature, mixing ratio, u wind, v wind).`));
  }
  if (!rows.length) throw new Error(NOT_A_SOUNDING);
  return { format: "cm1", surface, rows, site: "", date: "", time: "", skipped: 0 };
}

// SHARPpy files say so with their % markers; CM1 files are only numbers.
export function parseSounding(text) {
  return text.includes("%RAW%") || text.includes("%TITLE%") ? parseSharppy(text) : parseCm1(text);
}

export async function readSoundingFile(file) {
  const name = file.name.toLowerCase();
  // CM1 reads a file named input_sounding, with no extension.
  const bareCm1 = name.startsWith("input_sounding") && !name.includes(".");
  if (!bareCm1 && !FILE_EXTENSIONS.some((extension) => name.endsWith(extension))) {
    throw new Error(`Choose a sounding file (${FILE_EXTENSIONS.join(", ")} or input_sounding).`);
  }
  if (!file.size) throw new Error("This file is empty.");
  if (file.size > MAX_FILE_BYTES) throw new Error("This file is too large. The limit is 1 MB.");
  return parseSounding(decodeText(new Uint8Array(await file.arrayBuffer())));
}
