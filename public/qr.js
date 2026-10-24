/*
  Мини-генератор QR-кодов без внешних библиотек.
  Режим байтов (UTF-8), уровень коррекции M (~15% повреждений), версии 1–10 (до 213 байт).
  Использование: QR.svg("https://...", { size: 280 }) → строка с SVG.
*/
(function (global) {
  "use strict";

  // Для уровня M: [EC-кодслов на блок, [[кол-во блоков, данных в блоке], ...]]
  const EC_M = [null,
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]]];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // Поле Галуа GF(256) для кодов Рида — Соломона
  const EXP = new Array(512), LOG = new Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g;
  }

  function rsRemainder(data, n) {
    const g = rsGenerator(n);
    const buf = data.concat(new Array(n).fill(0));
    for (let i = 0; i < data.length; i++) {
      const c = buf[i];
      if (c) for (let j = 0; j < g.length; j++) buf[i + j] ^= mul(g[j], c);
    }
    return buf.slice(data.length);
  }

  function utf8(text) {
    if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, "utf8"));
  }

  function buildCodewords(bytes) {
    let ver;
    for (ver = 1; ver <= 10; ver++) {
      const cap = EC_M[ver][1].reduce((s, [n, k]) => s + n * k, 0) * 8;
      if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
    }
    if (ver > 10) throw new Error("Слишком длинный текст для QR-кода");

    const [ecLen, groups] = EC_M[ver];
    const dataCount = groups.reduce((s, [n, k]) => s + n * k, 0);
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0b0100, 4);                              // режим «байты»
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach(b => put(b, 8));
    put(0, Math.min(4, dataCount * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
    for (let pad = 0xec; data.length < dataCount; pad ^= 0xec ^ 0x11) data.push(pad);

    // делим на блоки, считаем коррекцию, перемежаем
    const blocks = [];
    let pos = 0;
    for (const [n, k] of groups) {
      for (let b = 0; b < n; b++) {
        const d = data.slice(pos, pos + k); pos += k;
        blocks.push({ d, e: rsRemainder(d, ecLen) });
      }
    }
    const out = [];
    const maxData = Math.max(...blocks.map(b => b.d.length));
    for (let i = 0; i < maxData; i++) blocks.forEach(b => { if (i < b.d.length) out.push(b.d[i]); });
    for (let i = 0; i < ecLen; i++) blocks.forEach(b => out.push(b.e[i]));
    return { ver, codewords: out };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  function makeMatrix(text) {
    const { ver, codewords } = buildCodewords(utf8(text));
    const size = 17 + ver * 4;
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, v) => { mod[r][c] = v; fixed[r][c] = true; };

    // поисковые узоры и разделители
    for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = fr + r, cc = fc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const d = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, d !== 2 && d !== 4);
      }
    }
    // синхронизирующие полосы
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    // выравнивающие узоры
    const al = ALIGN[ver];
    for (const r of al) for (const c of al) {
      if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
        set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
    // резерв под служебную информацию
    for (let i = 0; i < 9; i++) { fixed[8][i] = fixed[i][8] = true; }
    for (let i = 0; i < 8; i++) { fixed[8][size - 1 - i] = fixed[size - 1 - i][8] = true; }
    set(size - 8, 8, true); // тёмный модуль
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const vbits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((vbits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(b, a, bit); set(a, b, bit);
      }
    }

    // размещение данных змейкой
    const bits = [];
    codewords.forEach(cw => { for (let i = 7; i >= 0; i--) bits.push(((cw >>> i) & 1) === 1); });
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let v = 0; v < size; v++) {
        const r = upward ? size - 1 - v : v;
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          if (!fixed[r][c]) { mod[r][c] = k < bits.length ? bits[k] : false; k++; }
        }
      }
    }

    // выбор лучшей маски
    let best = null;
    for (let m = 0; m < 8; m++) {
      const grid = mod.map((row, r) => row.map((v, c) => (fixed[r][c] ? v : v !== MASKS[m](r, c))));
      writeFormat(grid, size, m);
      const score = penalty(grid, size);
      if (!best || score < best.score) best = { grid, score };
    }
    return best.grid;
  }

  function writeFormat(g, size, mask) {
    const data = (0b00 << 3) | mask; // уровень M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const b = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) g[i][8] = b(i);
    g[7][8] = b(6); g[8][8] = b(7); g[8][7] = b(8);
    for (let i = 9; i < 15; i++) g[8][14 - i] = b(i);
    for (let i = 0; i < 8; i++) g[8][size - 1 - i] = b(i);
    for (let i = 8; i < 15; i++) g[size - 15 + i][8] = b(i);
    g[size - 8][8] = true;
  }

  function penalty(g, size) {
    let score = 0, dark = 0;
    const lines = [];
    for (let i = 0; i < size; i++) { lines.push(g[i]); lines.push(g.map(row => row[i])); }
    for (const line of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && line[i] === line[i - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      const s = line.map(v => (v ? "1" : "0")).join("");
      score += 40 * ((s.match(/(?=10111010000|00001011101)/g) || []).length);
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = g[r][c];
      if (v === g[r][c + 1] && v === g[r + 1][c] && v === g[r + 1][c + 1]) score += 3;
    }
    g.forEach(row => row.forEach(v => { if (v) dark++; }));
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  }

  function svg(text, opts = {}) {
    const m = makeMatrix(text);
    const n = m.length, q = 4, total = n + q * 2;
    const px = opts.size || 256;
    let d = "";
    m.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${c + q} ${r + q}h1v1h-1z`; }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR-код: ${text.replace(/"/g, "&quot;")}">` +
      `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  const api = { matrix: makeMatrix, svg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.QR = api;
})(typeof window !== "undefined" ? window : globalThis);
