// Color math and the validated palettes. Classic script: also loads in Node tests.
(function (root) {
  'use strict';

  // Validated with the dataviz palette checks against the #101014 surface:
  // categorical passes all six checks (dark), the heat ramp passes the
  // ordinal checks, the diverging poles both clear 5:1.
  const PALETTE = {
    surface: '#101014',
    categorical: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    heat: ['#7a2d5c', '#a03375', '#c63d8e', '#e752a7', '#ff86c4'],
    // Continuous magnitude (composites): low values recede into the surface.
    glow: ['#1e1520', '#3f1a33', '#6e2852', '#a83479', '#e24c9e', '#ffa3d2'],
    no: '#3987e5',
    unsure: '#4a4a52',
    yes: '#e752a7',
    pending: '#1a1a21',
  };

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  }

  function rgbToHex(rgb) {
    return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  }

  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toGamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

  function rgbToOklab([r, g, b]) {
    const [lr, lg, lb] = [r, g, b].map(toLinear);
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  }

  function oklabToRgb([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map(toGamma);
  }

  const labCache = new Map();
  function lab(hex) {
    let v = labCache.get(hex);
    if (!v) {
      if (labCache.size > 4096) labCache.clear();
      labCache.set(hex, (v = rgbToOklab(hexToRgb(hex))));
    }
    return v;
  }

  // Perceptual blend between two hex colors.
  function mix(a, b, t) {
    const A = lab(a);
    const B = lab(b);
    return rgbToHex(oklabToRgb([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t)));
  }

  function ramp(stops, t) {
    const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    return mix(stops[i], stops[i + 1], x - i);
  }

  // Noul probability: blue (no) through neutral gray (unsure) to pink (yes).
  function diverging(p) {
    return p < 0.5 ? mix(PALETTE.no, PALETTE.unsure, p * 2) : mix(PALETTE.unsure, PALETTE.yes, (p - 0.5) * 2);
  }

  function luminance(hex) {
    const [r, g, b] = hexToRgb(hex).map(toLinear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  // Ink for a label sitting on `bg`: dark on bright fills, light otherwise.
  function inkOn(bg) {
    return luminance(bg) > 0.33 ? '#0b0b0f' : '#f4f4f6';
  }

  function rgba(hex, alpha) {
    const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
    return `rgba(${r},${g},${b},${alpha})`;
  }

  root.XColor = { PALETTE, mix, ramp, diverging, luminance, inkOn, rgba, hexToRgb };
})(typeof window !== 'undefined' ? window : globalThis);
