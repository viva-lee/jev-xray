// jev-xray front end: a canvas treemap of the repo, colored by Jev's answers.
// Runs live against the local server (SSE) or from an embedded snapshot.
(function () {
  'use strict';

  const { PALETTE, mix, ramp, diverging, hexToRgb } = window.XColor;
  const { buildTree, findNode, layout } = window.XTreemap;

  const EMBED = window.__XRAY__ || null;
  const LIVE = !EMBED;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const OTHER = '#6b6b78';
  const PENDING = hexToRgb(PALETTE.pending);

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const fmtInt = (n) => Math.round(n || 0).toLocaleString('en-US');
  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n || 0)));
  const fmtUsd = (n) => (n < 0.01 ? `$${(n || 0).toFixed(4)}` : n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

  const COMPOSITES = [
    {
      key: 'hotspot', label: 'Hotspots', type: 'composite', group: 'composite', needs: ['blast_radius', 'complexity'],
      hint: 'Blast radius × complexity × churn',
      instructions: 'Computed in code from Jev\'s answers: where a bug is both likely (complex, often changed) and costly (large blast radius).',
    },
    {
      key: 'doubt', label: 'Doubt', type: 'composite', group: 'composite', needs: [],
      hint: 'Where Jev is least sure',
      instructions: 'Computed in code: 1 − the average confidence of every answer for the file. Jev is calibrated, so these are the files to read yourself.',
    },
  ];

  const ASK_EXAMPLES = [
    { label: 'Talks to the DB?', type: 'noul', q: 'Does this file read from or write to a database?' },
    { label: 'Handles money?', type: 'noul', q: 'Does this file deal with payments, prices, billing or money?' },
    { label: 'Hidden side effects?', type: 'noul', q: 'Does this file have side effects a caller would not expect from its names?' },
    { label: 'Senior dev says WTF?', type: 'score', q: 'Would a senior engineer say "WTF" while reading this file?' },
    { label: 'Written in a hurry?', type: 'noul', q: 'Does this code look like it was written in a hurry?' },
    { label: 'Who owns it?', type: 'choice', q: 'Which team would most likely own this file?', options: 'frontend, backend, platform, data, security' },
  ];

  const S = {
    meta: {}, lenses: [], files: [], answers: {}, stats: {},
    active: null, selected: null, hover: null, hoverGroup: null, zoom: '',
    focus: null, pinned: null, running: false,
    stream: [], askType: 'noul',
    tree: null, nodePaths: new Set(), tiles: [], groups: [], tileById: new Map(), ranks: {},
    dirty: true, layoutT0: 0, recolorT0: 0, lastFlash: 0, maxChurn: 0,
    pendingAsk: false, streamSeq: 0, streamShown: 0,
  };

  /* ---------------------------------------------------------------- answers */

  const lensByKey = (k) => S.lenses.find((l) => l.key === k);
  const shortLevel = (text) => String(text).split(/[:.]/)[0].trim();
  const baseLenses = () => S.lenses.filter((l) => l.group !== 'composite');

  function choiceColor(lens, option) {
    const opts = Object.keys(lens.criteria);
    const i = opts.indexOf(option);
    if (i < 0) return OTHER;
    if (opts.length > 8 && i >= 7) return OTHER; // fold the tail, never cycle hues
    return PALETTE.categorical[i];
  }

  // Low confidence pulls a color toward the neutral gray: honest uncertainty.
  function fog(hex, conf) {
    const amount = clamp((0.75 - conf) / 0.75, 0, 1) * 0.6;
    return amount > 0.01 ? mix(hex, PALETTE.unsure, amount) : hex;
  }

  function confidenceOf(ans) {
    return ans.type === 'noul' ? Math.abs(2 * ans.noul - 1) : ans.confidence;
  }

  // Raw composite value, computed in code from Jev's answers.
  function compositeRaw(lens, f) {
    const a = S.answers[f.id] || {};
    if (lens.key === 'hotspot') {
      const b = a.blast_radius;
      const c = a.complexity;
      if (!b || !c) return null;
      const bt = b.score / (lensByKey('blast_radius').criteria.length - 1);
      const ct = c.score / (lensByKey('complexity').criteria.length - 1);
      const churn = S.maxChurn > 0 ? 0.25 + 0.75 * (Math.log1p(f.churn || 0) / Math.log1p(S.maxChurn)) : null;
      return {
        value: churn == null ? Math.sqrt(bt * ct) : Math.cbrt(bt * ct * churn),
        conf: Math.min(b.confidence, c.confidence),
        detail: `blast ${bt.toFixed(2)} · complexity ${ct.toFixed(2)}${churn != null ? ` · ${f.churn || 0} commits` : ''}`,
      };
    }
    const confs = baseLenses().map((l) => a[l.key]).filter(Boolean).map(confidenceOf);
    if (!confs.length) return null;
    return { value: 1 - confs.reduce((s, x) => s + x, 0) / confs.length, conf: 1, detail: `across ${confs.length} answers` };
  }

  // Composites are relative ("hottest in this repo"), so color by rank, with a
  // gamma so only the top of the distribution glows out of the dark.
  const GLOW_GAMMA = 2.2;
  const glowAt = (t) => ramp(PALETTE.glow, t ** GLOW_GAMMA);
  const glowGradient = () => Array.from({ length: 11 }, (_, i) => glowAt(i / 10)).join(', ');

  function compositeRanks(lens) {
    if (S.ranks[lens.key]) return S.ranks[lens.key];
    const rows = S.files.map((f) => [f.id, compositeRaw(lens, f)]).filter((r) => r[1]);
    rows.sort((x, y) => x[1].value - y[1].value);
    const map = new Map(rows.map(([id], i) => [id, rows.length > 1 ? i / (rows.length - 1) : 1]));
    S.ranks[lens.key] = map;
    return map;
  }

  function judge(lens, f) {
    if (!lens) return null;
    const a = S.answers[f.id] || {};
    if (lens.type === 'composite') {
      const raw = compositeRaw(lens, f);
      if (!raw) return null;
      const t = compositeRanks(lens).get(f.id) ?? 0;
      const top = Math.round((1 - t) * 100);
      return {
        color: glowAt(t), value: raw.value, conf: raw.conf, rank: t,
        label: raw.value.toFixed(2), bucket: Math.min(4, Math.floor(t * 5)),
        detail: `${top <= 50 ? `top ${Math.max(1, top)}%` : `bottom ${100 - top}%`} · ${raw.detail}`,
      };
    }
    const ans = a[lens.key];
    if (!ans) return null;
    if (ans.type === 'noul') {
      const p = ans.noul;
      return {
        color: diverging(p), value: p, conf: Math.abs(2 * p - 1),
        label: p >= 0.5 ? 'yes' : 'no', detail: `p ${p.toFixed(2)}`,
        bucket: p >= 0.7 ? 'yes' : p <= 0.3 ? 'no' : 'unsure',
      };
    }
    if (ans.type === 'score') {
      const n = lens.criteria.length;
      const t = ans.score / (n - 1);
      const lvl = clamp(Math.round(ans.score), 0, n - 1);
      return {
        color: fog(ramp(PALETTE.heat, t), ans.confidence), value: t, conf: ans.confidence,
        label: shortLevel(lens.criteria[lvl]), detail: `${ans.score.toFixed(2)} of ${n - 1} · conf ${ans.confidence.toFixed(2)}`, bucket: lvl,
      };
    }
    if (ans.type === 'choice') {
      const p = ans.probabilities ? ans.probabilities[ans.choice] : ans.confidence;
      return {
        color: fog(choiceColor(lens, ans.choice), ans.confidence), value: p, conf: ans.confidence,
        label: ans.choice, detail: `p ${p.toFixed(2)} · conf ${ans.confidence.toFixed(2)}`, bucket: ans.choice,
      };
    }
    return null;
  }

  // Which lenses need recoloring when answers for `keys` arrive.
  function affects(lens, keys) {
    if (!lens) return false;
    if (lens.key === 'doubt') return true;
    if (lens.key === 'hotspot') return keys.includes('blast_radius') || keys.includes('complexity');
    return keys.includes(lens.key);
  }

  /* ---------------------------------------------------------------- loading */

  function load(snap) {
    S.meta = snap.meta || {};
    S.files = snap.files || [];
    S.answers = snap.answers || {};
    for (const f of S.files) S.answers[f.id] = S.answers[f.id] || {};
    S.stats = snap.stats || {};
    S.running = Boolean(S.stats.running);
    S.maxChurn = Math.max(0, ...S.files.map((f) => f.churn || 0));
    const base = (snap.lenses || []).filter((l) => l.group !== 'composite');
    S.lenses = base.concat(COMPOSITES.filter((c) => base.length && c.needs.every((k) => base.some((l) => l.key === k))));
    const hash = readHash();
    S.active = hash.lens && lensByKey(hash.lens) ? hash.lens : (S.lenses[0] || {}).key || null;

    S.tree = buildTree(S.files, (f) => Math.max(60, Math.min(f.tokens, 12000)));
    S.nodePaths = new Set();
    (function walk(n) {
      S.nodePaths.add(n.path);
      for (const c of n.children || []) if (!c.file) walk(c);
    })(S.tree);
    if (hash.zoom && S.nodePaths.has(hash.zoom)) S.zoom = hash.zoom;
    const picked = hash.file ? S.files.find((f) => f.path === hash.file) : null;
    if (picked) S.selected = picked.id;

    $('repo-name').textContent = S.meta.name || 'repo';
    document.title = `${S.meta.name || 'repo'} · Jev X-Ray`;
    $('sim-banner').hidden = !S.meta.simulated;
    if (!LIVE) {
      $('ask-card').classList.add('static');
      $('static-note').hidden = false;
      $('stream-tag').textContent = 'recorded';
      $('stream-tag').classList.add('off');
    } else {
      $('btn-export').hidden = false;
    }
    renderChips();
    renderLenses();
    setActive(S.active, false);
    renderStats();
    renderInspector();
    renderStream();
  }

  // Shareable state: #lens=security&zoom=src/auth&file=src/auth/jwt.ts
  function readHash() {
    try {
      const p = new URLSearchParams(location.hash.slice(1));
      return { lens: p.get('lens'), zoom: p.get('zoom'), file: p.get('file') };
    } catch {
      return {};
    }
  }

  function writeHash() {
    const p = new URLSearchParams();
    if (S.active) p.set('lens', S.active);
    if (S.zoom) p.set('zoom', S.zoom);
    if (S.selected != null) p.set('file', S.files[S.selected].path);
    try {
      history.replaceState(null, '', `#${p.toString()}`);
    } catch {
      // some file:// contexts refuse; the view still works
    }
  }

  /* ----------------------------------------------------------------- layout */

  const canvas = $('map');
  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let DPR = 1;

  function resize() {
    const r = $('canvas-wrap').getBoundingClientRect();
    W = r.width;
    H = r.height;
    DPR = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    relayout(false);
  }

  function relayout(animate) {
    if (!S.tree || W < 10) return;
    const node = findNode(S.tree, S.zoom);
    const { tiles, groups } = layout(node, { x: 4, y: 4, w: W - 8, h: H - 8 }, { pad: 3, header: 17 });
    const prev = S.tileById;
    const next = new Map();
    const cx = W / 2;
    const cy = H / 2;
    for (const t of tiles) {
      const old = prev.get(t.file.id);
      if (old) {
        t.from = old.from; t.to = old.to; t.ct0 = old.ct0; t.flash = old.flash; t.j = old.j;
      }
      if (animate) {
        t.fx = old ? old.x : cx + (t.x - cx) * 0.2;
        t.fy = old ? old.y : cy + (t.y - cy) * 0.2;
        t.fw = old ? old.w : t.w * 0.2;
        t.fh = old ? old.h : t.h * 0.2;
      }
      next.set(t.file.id, t);
    }
    S.tiles = tiles;
    S.groups = groups;
    S.tileById = next;
    S.layoutT0 = animate && !REDUCED ? performance.now() : 0;
    recolor(false);
    renderCrumbs();
  }

  function recolor(animate) {
    const lens = lensByKey(S.active);
    const now = performance.now();
    for (const t of S.tiles) {
      const j = judge(lens, t.file);
      const target = j ? hexToRgb(j.color) : null;
      if (animate && !REDUCED) {
        t.from = currentRgb(t, now);
        t.ct0 = now;
      } else {
        t.ct0 = 0;
      }
      t.to = target;
      t.j = j;
    }
    if (animate) S.recolorT0 = now;
    computeBadges();
    S.dirty = true;
  }

  function updateTile(fileId, flash) {
    const t = S.tileById.get(fileId);
    if (!t) return;
    const now = performance.now();
    t.from = currentRgb(t, now);
    t.j = judge(lensByKey(S.active), t.file);
    t.to = t.j ? hexToRgb(t.j.color) : null;
    t.ct0 = REDUCED ? 0 : now;
    if (flash && !REDUCED) {
      t.flash = now;
      S.lastFlash = now;
    }
    S.dirty = true;
  }

  function currentRgb(t, now) {
    const to = t.to || PENDING;
    if (!t.ct0) return to;
    const p = (now - t.ct0) / 450;
    if (p >= 1) return to;
    const from = t.from || PENDING;
    const k = ease(p);
    return [0, 1, 2].map((i) => from[i] + (to[i] - from[i]) * k);
  }

  // Per-folder summary drawn in group headers.
  function computeBadges() {
    const lens = lensByKey(S.active);
    for (const g of S.groups) {
      const ids = g.node.ids || (g.node.ids = collectIds(g.node));
      const js = ids.map((id) => S.tileById.get(id)).filter((t) => t && t.j).map((t) => t.j);
      g.badge = '';
      if (!lens || !js.length) continue;
      if (lens.type === 'noul') {
        const yes = js.filter((j) => j.value >= 0.5).length;
        g.badge = `${yes}/${ids.length} yes`;
        g.badgeHot = yes > 0;
      } else if (lens.type === 'choice') {
        const counts = {};
        for (const j of js) counts[j.label] = (counts[j.label] || 0) + 1;
        const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        g.badge = `${top} ${Math.round((100 * n) / js.length)}%`;
        g.badgeHot = false;
      } else {
        const mean = js.reduce((s, j) => s + j.value, 0) / js.length;
        g.badge = `avg ${mean.toFixed(2)}`;
        g.badgeHot = mean > 0.6;
      }
    }
  }

  function collectIds(node) {
    const out = [];
    (function walk(n) {
      for (const c of n.children) c.file ? out.push(c.file.id) : walk(c);
    })(node);
    return out;
  }

  /* ------------------------------------------------------------------- draw */

  const rgbStr = (c) => `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
  const lumOf = (c) => {
    const lin = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };

  function rectAt(t, mp) {
    if (mp >= 1 || t.fx == null) return t;
    return {
      x: t.fx + (t.x - t.fx) * mp,
      y: t.fy + (t.y - t.fy) * mp,
      w: t.fw + (t.w - t.fw) * mp,
      h: t.fh + (t.h - t.fh) * mp,
    };
  }

  function fitText(text, maxWidth, charW) {
    const max = Math.floor(maxWidth / charW);
    if (max < 3) return '';
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  }

  function draw(now) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = PALETTE.surface;
    ctx.fillRect(0, 0, W, H);
    const mp = S.layoutT0 ? clamp((now - S.layoutT0) / 520, 0, 1) : 1;
    const em = ease(mp);
    const focus = S.focus || S.pinned;

    // folders
    ctx.globalAlpha = em;
    for (const g of S.groups) {
      ctx.fillStyle = g === S.hoverGroup ? '#1d1d26' : g.depth % 2 ? '#16161d' : '#131318';
      ctx.beginPath();
      ctx.roundRect(g.x + 1, g.y + 1, g.w - 2, g.h - 2, 4);
      ctx.fill();
      if (g.header) {
        ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
        ctx.textBaseline = 'middle';
        const badge = g.badge || '';
        const bw = badge && g.w > 170 ? badge.length * 6.1 + 10 : 0;
        ctx.fillStyle = g === S.hoverGroup ? '#ff3d8b' : '#8a8a99';
        ctx.fillText(fitText(`${g.node.name.toUpperCase()}/`, g.w - 12 - bw, 6.1), g.x + 6, g.y + 10);
        if (bw) {
          ctx.fillStyle = g.badgeHot ? '#ff86c4' : '#6d6d7b';
          ctx.textAlign = 'right';
          ctx.fillText(badge, g.x + g.w - 6, g.y + 10);
          ctx.textAlign = 'left';
        }
      }
    }
    ctx.globalAlpha = 1;

    // files
    const shimmer = S.running && !REDUCED;
    for (const t of S.tiles) {
      const r = rectAt(t, em);
      const x = r.x + 1;
      const y = r.y + 1;
      const w = r.w - 2;
      const h = r.h - 2;
      if (w <= 0.4 || h <= 0.4) continue;
      const rgb = currentRgb(t, now);
      const dim = focus && !(t.j && focus.test(t.j));
      ctx.globalAlpha = dim ? 0.12 : 1;
      ctx.fillStyle = rgbStr(rgb);
      if (w > 5 && h > 5) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, 2);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, w, h);
      }
      if (!t.to && shimmer) {
        const s = 0.5 + 0.5 * Math.sin((x * 0.8 + y * 0.35) / 55 - now / 240);
        ctx.fillStyle = `rgba(255,61,139,${0.04 + 0.09 * s})`;
        ctx.fillRect(x, y, w, h);
      }
      if (t.flash && now - t.flash < 900) {
        const k = 1 - (now - t.flash) / 900;
        ctx.fillStyle = `rgba(255,255,255,${0.7 * k * k})`;
        ctx.fillRect(x, y, w, h);
        const grow = (1 - k) * 9;
        ctx.strokeStyle = `rgba(255,134,196,${0.9 * k})`;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x - grow, y - grow, w + 2 * grow, h + 2 * grow);
      }
      if (!dim && w >= 50 && h >= 17 && em === 1) {
        const ink = t.to && lumOf(rgb) > 0.3 ? 'rgba(10,10,14,0.92)' : 'rgba(244,244,246,0.92)';
        ctx.fillStyle = ink;
        ctx.textBaseline = 'top';
        ctx.font = '500 11px "JetBrains Mono", ui-monospace, monospace';
        ctx.fillText(fitText(t.file.name, w - 10, 6.7), x + 5, y + 4);
        if (h >= 32 && t.j) {
          ctx.globalAlpha = 0.72;
          ctx.font = '400 10px "JetBrains Mono", ui-monospace, monospace';
          ctx.fillText(fitText(t.j.label, w - 10, 6.1), x + 5, y + 18);
        }
      }
    }
    ctx.globalAlpha = 1;

    const sel = S.selected != null && S.tileById.get(S.selected);
    if (sel) {
      ctx.save();
      ctx.shadowColor = '#ff3d8b';
      ctx.shadowBlur = 14;
      ctx.strokeStyle = '#ff3d8b';
      ctx.lineWidth = 2;
      ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w - 1, sel.h - 1);
      ctx.restore();
    }
    const hov = S.hover != null && S.tileById.get(S.hover);
    if (hov && hov !== sel) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hov.x + 0.75, hov.y + 0.75, hov.w - 1.5, hov.h - 1.5);
    }

    const judged = S.tiles.filter((t) => t.to).length;
    if (S.running && judged === 0) {
      ctx.fillStyle = 'rgba(8,8,11,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f4f4f6';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '800 28px Inter, system-ui, sans-serif';
      ctx.fillText(`Judging ${fmtInt(S.tiles.length)} files`, W / 2, H / 2 - 12);
      ctx.font = '400 12px "JetBrains Mono", ui-monospace, monospace';
      ctx.fillStyle = '#ff86c4';
      ctx.fillText('one typed call per file · answers stream in as they land', W / 2, H / 2 + 18);
      ctx.textAlign = 'left';
    }
  }

  function frame(now) {
    const animating = S.running ||
      (S.layoutT0 && now - S.layoutT0 < 560) ||
      now - S.recolorT0 < 480 ||
      now - S.lastFlash < 950;
    if (S.dirty || animating) {
      draw(now);
      S.dirty = false;
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------ interaction */

  function hitTile(mx, my) {
    for (let i = S.tiles.length - 1; i >= 0; i--) {
      const t = S.tiles[i];
      if (mx >= t.x && mx < t.x + t.w && my >= t.y && my < t.y + t.h) return t;
    }
    return null;
  }

  function hitHeader(mx, my) {
    let best = null;
    for (const g of S.groups) {
      if (g.header && mx >= g.x && mx < g.x + g.w && my >= g.y && my < g.y + g.header + 2) {
        if (!best || g.depth > best.depth) best = g;
      }
    }
    return best;
  }

  function pointer(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('mousemove', (e) => {
    const [mx, my] = pointer(e);
    const g = hitHeader(mx, my);
    const t = g ? null : hitTile(mx, my);
    const id = t ? t.file.id : null;
    if (id !== S.hover || g !== S.hoverGroup) {
      S.hover = id;
      S.hoverGroup = g;
      S.dirty = true;
    }
    canvas.style.cursor = g ? 'zoom-in' : t ? 'pointer' : 'default';
    showTooltip(t, g, mx, my);
  });

  canvas.addEventListener('mouseleave', () => {
    S.hover = null;
    S.hoverGroup = null;
    S.dirty = true;
    $('tooltip').hidden = true;
  });

  canvas.addEventListener('click', (e) => {
    const [mx, my] = pointer(e);
    const g = hitHeader(mx, my);
    if (g) return zoomTo(g.node.path);
    const t = hitTile(mx, my);
    select(t ? t.file.id : null);
  });

  canvas.addEventListener('dblclick', (e) => {
    const [mx, my] = pointer(e);
    const t = hitTile(mx, my);
    if (t && t.file.dir && t.file.dir !== S.zoom) zoomTo(t.file.dir);
  });

  function showTooltip(t, g, mx, my) {
    const tip = $('tooltip');
    if (!t && !g) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren();
    if (g) {
      tip.append(el('div', 'tt-value', `${g.node.path || '/'}/`));
      tip.append(el('div', 'tt-sub', `${collectIds(g.node).length} files${g.badge ? ` · ${g.badge}` : ''} · click to zoom`));
    } else {
      const lens = lensByKey(S.active);
      const v = el('div', 'tt-value');
      if (t.j) {
        const key = el('span', 'tt-key');
        key.style.background = t.j.color;
        v.append(key, el('span', null, t.j.label));
      } else {
        v.append(el('span', null, S.running ? 'judging…' : 'no answer'));
      }
      tip.append(v);
      tip.append(el('div', 'tt-path', t.file.path));
      const bits = [lens ? lens.label : ''];
      if (t.j) bits.push(t.j.detail);
      bits.push(`${fmtInt(t.file.lines)} lines`);
      tip.append(el('div', 'tt-sub', bits.filter(Boolean).join(' · ')));
    }
    tip.hidden = false;
    const wrap = $('canvas-wrap').getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${mx + 16 + tw > wrap.width ? mx - tw - 12 : mx + 16}px`;
    tip.style.top = `${my + 16 + th > wrap.height ? my - th - 12 : my + 16}px`;
  }

  function zoomTo(path) {
    if (!S.nodePaths.has(path)) path = '';
    if (path === S.zoom) return;
    S.zoom = path;
    relayout(true);
    writeHash();
  }

  function zoomOut() {
    if (!S.zoom) return false;
    const parts = S.zoom.split('/');
    while (parts.length) {
      parts.pop();
      const p = parts.join('/');
      if (S.nodePaths.has(p)) {
        zoomTo(p);
        return true;
      }
    }
    zoomTo('');
    return true;
  }

  function renderCrumbs() {
    const nav = $('crumbs');
    nav.replaceChildren();
    const rootBtn = el('button', null, `${S.meta.name || 'repo'}/`);
    rootBtn.onclick = () => zoomTo('');
    nav.append(rootBtn);
    if (!S.zoom) return;
    const parts = S.zoom.split('/');
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      nav.append(el('span', 'sep', '›'));
      if (i === parts.length - 1) {
        nav.append(el('span', 'here', part));
      } else if (S.nodePaths.has(acc)) {
        const p = acc;
        const b = el('button', null, part);
        b.onclick = () => zoomTo(p);
        nav.append(b);
      } else {
        nav.append(el('span', null, part));
      }
    });
  }

  function select(id) {
    S.selected = id;
    S.dirty = true;
    renderInspector();
    writeHash();
  }

  /* ------------------------------------------------------------------ lenses */

  function setActive(key, animate = true) {
    S.active = key;
    S.focus = null;
    S.pinned = null;
    const lens = lensByKey(key);
    $('lens-name').textContent = lens ? lens.label : 'No lens yet';
    $('lens-question').textContent = !lens ? 'Ask a question to start.'
      : lens.group === 'asked' ? `Your question, asked of all ${fmtInt(S.files.length)} files as a typed ${lens.type === 'noul' ? 'yes/no' : lens.type} question.`
      : lens.instructions.replace(/`/g, '');
    const chip = $('lens-type');
    chip.textContent = lens ? (lens.type === 'noul' ? 'yes / no' : lens.type) : '';
    chip.className = `type-chip ${lens ? lens.type : ''}`;
    for (const b of document.querySelectorAll('.lens')) b.classList.toggle('on', b.dataset.key === key);
    recolor(animate);
    renderLegend();
    renderTop();
    renderInspector();
    writeHash();
  }

  function dist(lens) {
    const box = el('div', 'dist');
    const js = S.files.map((f) => judge(lens, f)).filter(Boolean);
    if (lens.type === 'choice') {
      box.classList.add('stack');
      const opts = Object.keys(lens.criteria);
      const counts = opts.map((o) => js.filter((j) => j.label === o).length);
      const total = Math.max(1, counts.reduce((a, b) => a + b, 0));
      opts.forEach((o, i) => {
        if (!counts[i]) return;
        const s = el('span');
        s.style.width = `calc(${(100 * counts[i]) / total}% - 2px)`;
        s.style.background = choiceColor(lens, o);
        s.title = `${o}: ${counts[i]}`;
        box.append(s);
      });
      return box;
    }
    const bins = lens.type === 'score' ? lens.criteria.length : 10;
    const counts = new Array(bins).fill(0);
    for (const j of js) {
      const i = lens.type === 'score' ? j.bucket : Math.min(bins - 1, Math.floor(clamp(j.value, 0, 0.9999) * bins));
      counts[i]++;
    }
    const max = Math.max(1, ...counts);
    counts.forEach((c, i) => {
      const s = el('span');
      const mid = (i + 0.5) / bins;
      s.style.height = `${Math.max(1, (14 * c) / max)}px`;
      s.style.background = lens.type === 'noul' ? diverging(mid) : lens.type === 'score' ? ramp(PALETTE.heat, i / (bins - 1)) : glowAt(mid);
      s.style.opacity = c ? 1 : 0.25;
      box.append(s);
    });
    return box;
  }

  function renderLenses() {
    const host = $('lens-list');
    host.replaceChildren();
    const groups = [
      ['built-in', 'Lenses'],
      ['asked', 'Your questions'],
      ['composite', 'Computed from answers'],
    ];
    groups.forEach(([g, title]) => {
      const ls = S.lenses.filter((l) => l.group === g);
      if (!ls.length) return;
      const sec = el('div', 'lens-group');
      sec.append(el('h2', null, title));
      for (const lens of ls) {
        const b = el('button', 'lens');
        b.type = 'button';
        b.dataset.key = lens.key;
        const row = el('div', 'lens-row');
        row.append(el('span', 'lens-name', lens.label));
        const idx = S.lenses.indexOf(lens);
        if (idx < 9) row.append(el('span', 'lens-key', String(idx + 1)));
        row.append(el('span', `type-chip ${lens.type}`, lens.type === 'noul' ? 'yes/no' : lens.type));
        b.append(row, el('div', 'lens-hint', lens.hint || lens.instructions));
        const d = el('div', 'dist-host');
        b.append(d);
        if (lens.group !== 'composite') {
          const pr = el('div', 'progress');
          pr.append(el('i'));
          b.append(pr);
        }
        b.onclick = () => setActive(lens.key);
        sec.append(b);
      }
      host.append(sec);
    });
    for (const b of document.querySelectorAll('.lens')) b.classList.toggle('on', b.dataset.key === S.active);
    updateLensDists();
  }

  function updateLensDists() {
    for (const b of document.querySelectorAll('.lens')) {
      const lens = lensByKey(b.dataset.key);
      if (!lens) continue;
      b.querySelector('.dist-host').replaceChildren(dist(lens));
      const bar = b.querySelector('.progress i');
      if (bar) {
        const done = S.files.filter((f) => S.answers[f.id][lens.key]).length;
        bar.style.width = `${(100 * done) / Math.max(1, S.files.length)}%`;
        bar.parentElement.style.visibility = done >= S.files.length ? 'hidden' : 'visible';
      }
    }
  }

  function addLens(lens) {
    if (lensByKey(lens.key)) return;
    const firstComposite = S.lenses.findIndex((l) => l.group === 'composite');
    if (firstComposite === -1) S.lenses.push(lens);
    else S.lenses.splice(firstComposite, 0, lens);
    if (!S.lenses.some((l) => l.key === 'doubt')) S.lenses.push(COMPOSITES[1]);
    renderLenses();
  }

  /* ------------------------------------------------------------------ legend */

  function setFocus(test, pin, id) {
    if (pin) {
      S.pinned = S.pinned && S.pinned.id === id ? null : { test, id };
    } else {
      S.focus = test ? { test, id } : null;
    }
    for (const it of document.querySelectorAll('#legend [data-id]')) {
      const f = S.focus || S.pinned;
      it.classList.toggle('on', Boolean(f && f.id === it.dataset.id));
      it.classList.toggle('off', Boolean(f && f.id !== it.dataset.id));
    }
    S.dirty = true;
  }

  function legendItem(id, color, label, count, test) {
    const b = el('button', 'item');
    b.type = 'button';
    b.dataset.id = id;
    const sw = el('span', 'sw');
    sw.style.background = color;
    b.append(sw, el('span', null, label), el('span', 'count', fmtInt(count)));
    b.onmouseenter = () => setFocus(test, false, id);
    b.onmouseleave = () => setFocus(null, false);
    b.onfocus = b.onmouseenter;
    b.onblur = b.onmouseleave;
    b.onclick = () => setFocus(test, true, id);
    return b;
  }

  function renderLegend() {
    const host = $('legend');
    host.replaceChildren();
    const lens = lensByKey(S.active);
    if (!lens) return;
    const js = S.files.map((f) => judge(lens, f)).filter(Boolean);
    if (lens.type === 'choice') {
      for (const o of Object.keys(lens.criteria)) {
        const n = js.filter((j) => j.label === o).length;
        host.append(legendItem(o, choiceColor(lens, o), o, n, (j) => j.label === o));
      }
      return;
    }
    if (lens.type === 'noul') {
      const buckets = [['no', PALETTE.no, 'no  (p ≤ 0.3)'], ['unsure', PALETTE.unsure, 'unsure'], ['yes', PALETTE.yes, 'yes  (p ≥ 0.7)']];
      for (const [id, color, label] of buckets) {
        host.append(legendItem(id, color, label, js.filter((j) => j.bucket === id).length, (j) => j.bucket === id));
      }
      const r = el('div', 'ramp');
      const bar = el('div', 'ramp-bar');
      bar.style.background = `linear-gradient(90deg, ${PALETTE.no}, ${PALETTE.unsure}, ${PALETTE.yes})`;
      const labels = el('div', 'ramp-labels');
      labels.append(el('span', null, 'p = 0'), el('span', null, '0.5'), el('span', null, '1'));
      r.append(bar, labels);
      host.append(r);
      return;
    }
    const levels = lens.type === 'score'
      ? lens.criteria.map(shortLevel)
      : ['bottom 20%', '', 'middle', '', 'top 20% of repo'];
    const r = el('div', 'ramp');
    const bar = el('div', 'ramp-bar');
    bar.style.background = `linear-gradient(90deg, ${lens.type === 'score' ? PALETTE.heat.join(', ') : glowGradient()})`;
    const labels = el('div', 'ramp-labels');
    levels.forEach((name, i) => {
      if (!name) return labels.append(el('span'));
      const n = js.filter((j) => j.bucket === i).length;
      const b = el('button', null, `${name} ${n ? `· ${n}` : ''}`);
      b.type = 'button';
      b.dataset.id = `l${i}`;
      const test = (j) => j.bucket === i;
      b.onmouseenter = () => setFocus(test, false, `l${i}`);
      b.onmouseleave = () => setFocus(null, false);
      b.onclick = () => setFocus(test, true, `l${i}`);
      labels.append(b);
    });
    r.append(bar, labels);
    host.append(r);
  }

  /* --------------------------------------------------------------- inspector */

  function answerRow(lens, f) {
    const row = el('div', `ans${lens.key === S.active ? ' active' : ''}`);
    const j = judge(lens, f);
    const head = el('div', 'ans-head');
    head.append(el('span', 'ans-label', lens.label));
    const val = el('span', 'ans-val', j ? j.label : '—');
    if (j) val.append(el('small', null, lens.type === 'noul' ? j.value.toFixed(2) : lens.type === 'composite' ? '' : `conf ${j.conf.toFixed(2)}`));
    head.append(val);
    row.append(head);
    const ans = S.answers[f.id][lens.key];
    if (lens.type === 'noul' && ans) {
      const g = el('div', 'gauge');
      g.style.background = `linear-gradient(90deg, ${PALETTE.no}, ${PALETTE.unsure}, ${PALETTE.yes})`;
      const m = el('i');
      m.style.left = `${ans.noul * 100}%`;
      g.append(m);
      row.append(g);
    } else if (lens.type === 'score' && ans) {
      const cells = el('div', 'cells');
      lens.criteria.forEach((c, i) => {
        const s = el('span');
        const p = ans.probabilities ? ans.probabilities[String(i)] || 0 : 0;
        s.style.background = ramp(PALETTE.heat, i / (lens.criteria.length - 1));
        s.style.opacity = String(0.12 + 0.88 * Math.sqrt(p));
        s.title = `${shortLevel(c)}: ${(p * 100).toFixed(0)}%`;
        cells.append(s);
      });
      row.append(cells);
    } else if (lens.type === 'choice' && ans && ans.probabilities) {
      const bars = el('div', 'bars');
      Object.entries(ans.probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([o, p]) => {
        const d = el('div');
        const track = el('span', 'track');
        const fill = el('i');
        fill.style.width = `${p * 100}%`;
        fill.style.background = choiceColor(lens, o);
        track.append(fill);
        d.append(el('span', null, o), track, el('span', 'p', p.toFixed(2)));
        bars.append(d);
      });
      row.append(bars);
    } else if (lens.type === 'composite' && j) {
      row.append(el('div', 'tt-sub', j.detail));
    }
    return row;
  }

  function renderInspector() {
    const host = $('inspector');
    host.replaceChildren();
    host.append(el('h2', null, 'Inspector'));
    const f = S.selected != null ? S.files[S.selected] : null;
    if (!f) {
      const p = el('p', 'empty', 'Click any file to see every decision Jev made about it: the answer, the full probability distribution, and how sure it was.');
      host.append(p);
      return;
    }
    const path = el('div', 'insp-path');
    if (f.dir) path.append(el('span', 'dir', `${f.dir}/`));
    path.append(el('b', null, f.name));
    host.append(path);
    const meta = el('div', 'insp-meta');
    const bits = [f.lang, `${fmtInt(f.lines)} lines`, `~${fmtTok(f.tokens)} tok`];
    if (f.churn) bits.push(`${f.churn} commits / 12 mo`);
    if (f.truncated) bits.push('excerpted');
    for (const b of bits) meta.append(el('span', null, b));
    host.append(meta);
    for (const lens of S.lenses) host.append(answerRow(lens, f));

    const actions = el('div', 'insp-actions');
    const lens = lensByKey(S.active);
    if (LIVE && lens && lens.group !== 'composite') {
      const b = el('button', 'btn primary', `Find the lines → ${lens.label}`);
      b.type = 'button';
      b.onclick = () => findLines(f.id, lens.key, b);
      actions.append(b);
    }
    if (f.dir) {
      const z = el('button', 'btn', 'Zoom to folder');
      z.type = 'button';
      z.onclick = () => zoomTo(f.dir);
      actions.append(z);
    }
    host.append(actions);
  }

  /* ---------------------------------------------------------------- top list */

  function renderTop() {
    const host = $('toplist');
    host.replaceChildren();
    const lens = lensByKey(S.active);
    if (!lens) return;
    const rows = S.files.map((f) => ({ f, j: judge(lens, f) })).filter((r) => r.j);
    if (lens.type === 'choice') {
      $('top-title').textContent = `${lens.label}: breakdown`;
      for (const o of Object.keys(lens.criteria)) {
        const n = rows.filter((r) => r.j.label === o).length;
        const li = el('li', 'count-row');
        const v = el('span', 'v');
        const k = el('span', 'k');
        k.style.background = choiceColor(lens, o);
        v.append(k, el('span', null, o));
        li.append(v, el('span', 'v', `${fmtInt(n)} · ${Math.round((100 * n) / Math.max(1, rows.length))}%`));
        li.onclick = () => setFocus((j) => j.label === o, true, o);
        host.append(li);
      }
      return;
    }
    $('top-title').textContent = lens.type === 'noul' ? `Most likely yes: ${lens.label}` : `Highest: ${lens.label}`;
    rows.sort((a, b) => b.j.value - a.j.value).slice(0, 10).forEach(({ f, j }) => {
      const li = el('li');
      const v = el('span', 'v');
      const k = el('span', 'k');
      k.style.background = j.color;
      v.append(k, el('span', null, j.value.toFixed(2)));
      const p = el('span', 'p');
      p.append(document.createTextNode(`‎${f.path}`));
      li.append(v, p);
      li.title = f.path;
      li.onclick = () => {
        if (f.dir !== S.zoom && S.zoom && !f.path.startsWith(`${S.zoom}/`)) zoomTo('');
        select(f.id);
      };
      host.append(li);
    });
  }

  /* ------------------------------------------------------------------ stream */

  function renderStream() {
    const host = $('stream');
    if (!LIVE) {
      host.replaceChildren();
      const s = S.stats;
      const li = el('li');
      li.style.gridTemplateColumns = '1fr';
      li.textContent = `Recorded run · ${fmtInt(s.requests)} requests · p50 ${Math.round(s.p50 || 0)} ms · ${(s.elapsed || 0).toFixed(1)} s`;
      host.append(li);
      return;
    }
    const lens = lensByKey(S.active);
    host.replaceChildren();
    for (const item of S.stream.slice(0, 14)) {
      const f = S.files[item.fileId];
      const j = judge(lens, f);
      const li = el('li', item.seq > S.streamShown ? 'in' : null);
      const v = el('span', 'v');
      const k = el('span', 'k');
      k.style.background = j ? j.color : '#333';
      v.append(k, el('span', null, j ? (lens.type === 'choice' ? j.label.slice(0, 5) : j.value.toFixed(2)) : '··'));
      const p = el('span', 'p');
      p.append(document.createTextNode(`‎${f.path}`));
      li.append(v, p, el('span', 'ms', item.cached ? 'cache' : `${Math.round(item.latencyMs)}ms`));
      li.onclick = () => select(f.id);
      li.style.cursor = 'pointer';
      host.append(li);
    }
    S.streamShown = S.stream.length ? S.stream[0].seq : 0;
  }

  /* ------------------------------------------------------------------- stats */

  function renderStats() {
    const s = S.stats || {};
    $('st-files').textContent = `${fmtInt(s.judged || 0)}/${fmtInt(s.total || S.files.length)}`;
    $('st-decisions').textContent = fmtInt(s.decisions);
    $('st-tokens').textContent = fmtTok(s.inputTokens || 0);
    $('st-cost').textContent = fmtUsd(s.costUsd || 0);
    $('st-p50').textContent = s.p50 ? `${Math.round(s.p50)} ms` : '-';
    const dot = $('st-dot');
    dot.className = `dot ${S.meta.simulated ? 'sim' : S.running ? 'live' : 'idle'}`;
    $('st-model').textContent = S.meta.simulated ? 'simulated' : s.model || S.meta.model || '-';
    $('scanline').classList.toggle('on', S.running && !REDUCED);
    const price = S.meta.pricePerMTok || 0.042;
    const when = S.meta.generatedAt ? new Date(S.meta.generatedAt).toLocaleString() : '';
    $('foot-meta').textContent = [
      S.meta.simulated ? 'simulated answers (no Jev calls)' : s.model || S.meta.model,
      `$${price} per 1M input tokens · output free`,
      s.cachedFiles ? `${fmtInt(s.cachedFiles)} files from cache` : '',
      LIVE ? '' : `recorded ${when}`,
    ].filter(Boolean).join(' · ');
    $('ask-count').textContent = `${fmtInt(S.files.length)} files`;
  }

  let uiTimer = null;
  function scheduleUi() {
    if (uiTimer) return;
    uiTimer = setTimeout(() => {
      uiTimer = null;
      renderStats();
      updateLensDists();
      renderLegend();
      renderTop();
      renderStream();
      if (S.selected != null) renderInspector();
      if (S.recolorPending) {
        S.recolorPending = false;
        recolor(true);
      }
      computeBadges();
      S.dirty = true;
    }, 160);
  }

  /* --------------------------------------------------------------------- ask */

  function renderChips() {
    const host = $('ask-chips');
    host.replaceChildren();
    for (const ex of ASK_EXAMPLES) {
      const b = el('button', null, ex.label);
      b.type = 'button';
      b.title = ex.q;
      b.onclick = () => {
        $('ask-input').value = ex.q;
        setAskType(ex.type);
        $('ask-options').value = ex.options || '';
        $('ask-input').focus();
      };
      host.append(b);
    }
  }

  function setAskType(type) {
    S.askType = type;
    for (const b of document.querySelectorAll('.seg button')) {
      const on = b.dataset.type === type;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    $('ask-options').hidden = type !== 'choice';
  }

  for (const b of document.querySelectorAll('.seg button')) b.onclick = () => setAskType(b.dataset.type);

  $('ask-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('ask-form').requestSubmit();
    }
  });

  $('ask-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!LIVE || S.pendingAsk) return;
    const question = $('ask-input').value.trim();
    if (!question) return;
    const options = $('ask-options').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    S.pendingAsk = true;
    $('ask-go').disabled = true;
    try {
      const res = await fetch('api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, type: S.askType, options }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      addLens(data.lens);
      S.running = true;
      setActive(data.lens.key);
      $('ask-input').value = '';
    } catch (err) {
      toast(err.message);
    } finally {
      S.pendingAsk = false;
      $('ask-go').disabled = false;
    }
  });

  /* ------------------------------------------------------------------- lines */

  async function findLines(fileId, lensKey, button) {
    const modal = $('lines-modal');
    const f = S.files[fileId];
    const lens = lensByKey(lensKey);
    $('lines-path').textContent = f.path;
    $('lines-question').textContent = lens.hint && lens.group === 'asked' ? lens.hint : lens.instructions.replace(/`/g, '');
    $('lines-meta').replaceChildren();
    const code = $('lines-code');
    code.replaceChildren(el('div', 'loading', 'Asking Jev which lines…'));
    modal.hidden = false;
    if (button) button.disabled = true;
    try {
      const res = await fetch('api/lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, lensKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      renderLines(data);
    } catch (err) {
      code.replaceChildren(el('div', 'loading', `Failed: ${err.message}`));
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderLines(data) {
    const code = $('lines-code');
    const meta = $('lines-meta');
    const max = Math.max(1e-9, ...data.lines.map((l) => l.score));
    const bestExists = Math.max(0, ...data.windows.map((w) => w.exists));
    code.replaceChildren();
    const frag = document.createDocumentFragment();
    const rows = [];
    for (const line of data.lines) {
      const row = el('div', 'ln');
      const k = line.score / max;
      if (k > 0.04 && bestExists > 0.15) {
        row.style.background = `linear-gradient(90deg, rgba(231,82,167,${(0.55 * k ** 0.7).toFixed(3)}), rgba(231,82,167,${(0.12 * k).toFixed(3)}) 70%, transparent)`;
        if (k > 0.5) row.classList.add('hot');
      }
      row.append(el('span', 'n', String(line.n)), el('span', 't', line.text || ' '));
      rows.push(row);
      frag.append(row);
    }
    code.append(frag);

    meta.replaceChildren();
    const top = [...data.lines].sort((a, b) => b.score - a.score).slice(0, 5).filter((l) => l.score > 0);
    meta.append(el('span', 'note', bestExists >= 0.5
      ? `Evidence found · p ${bestExists.toFixed(2)} · strongest lines:`
      : `No single line stands out (p ${bestExists.toFixed(2)}): the judgment is about the file as a whole.`));
    if (bestExists >= 0.15) {
      for (const l of top) {
        const b = el('button', 'pill', `L${l.n} · ${(l.score / max).toFixed(2)}`);
        b.type = 'button';
        b.onclick = () => jumpTo(rows[l.n - 1]);
        meta.append(b);
      }
    }
    meta.append(el('span', 'note', `· ${data.windows.length} call${data.windows.length > 1 ? 's' : ''} · ${fmtTok(data.inputTokens)} tok · ${Math.round(data.latencyMs)} ms${data.clipped ? ' · first 2,000 lines' : ''}`));

    drawMinimap(data, max, bestExists, rows);
    if (top[0] && bestExists >= 0.15) jumpTo(rows[top[0].n - 1]);
  }

  function jumpTo(row) {
    if (!row) return;
    row.scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1200);
  }

  function drawMinimap(data, max, bestExists, rows) {
    const mm = $('lines-minimap');
    const h = $('lines-code').clientHeight;
    const dpr = window.devicePixelRatio || 1;
    mm.style.height = `${h}px`;
    mm.width = 18 * dpr;
    mm.height = h * dpr;
    const c = mm.getContext('2d');
    c.scale(dpr, dpr);
    c.fillStyle = PALETTE.surface;
    c.fillRect(0, 0, 18, h);
    const n = data.lines.length;
    data.lines.forEach((l, i) => {
      const k = l.score / max;
      if (k < 0.04 || bestExists < 0.15) return;
      c.fillStyle = `rgba(255,134,196,${0.25 + 0.75 * k})`;
      c.fillRect(3, (i / n) * h, 12, Math.max(2, h / n));
    });
    mm.onclick = (e) => {
      const r = mm.getBoundingClientRect();
      jumpTo(rows[Math.floor(((e.clientY - r.top) / r.height) * n)]);
    };
  }

  /* ------------------------------------------------------------------- table */

  let tableSort = { key: 'path', dir: 1 };

  function renderTable() {
    const table = $('table');
    const filter = $('table-filter').value.trim().toLowerCase();
    table.replaceChildren();
    const thead = el('thead');
    const hr = el('tr');
    const cols = [{ key: 'path', label: 'Path' }].concat(S.lenses.map((l) => ({ key: l.key, label: l.label })));
    for (const c of cols) {
      const th = el('th', null, c.label + (tableSort.key === c.key ? (tableSort.dir > 0 ? ' ↑' : ' ↓') : ''));
      th.onclick = () => {
        tableSort = { key: c.key, dir: tableSort.key === c.key ? -tableSort.dir : c.key === 'path' ? 1 : -1 };
        renderTable();
      };
      hr.append(th);
    }
    thead.append(hr);
    let files = S.files.filter((f) => !filter || f.path.toLowerCase().includes(filter));
    if (tableSort.key === 'path') {
      files.sort((a, b) => a.path.localeCompare(b.path) * tableSort.dir);
    } else {
      const lens = lensByKey(tableSort.key);
      const val = (f) => {
        const j = judge(lens, f);
        return j ? j.value : -1;
      };
      files = files.map((f) => [f, val(f)]).sort((a, b) => (a[1] - b[1]) * tableSort.dir).map((x) => x[0]);
    }
    const tbody = el('tbody');
    for (const f of files) {
      const tr = el('tr');
      tr.append(el('td', 'path', f.path));
      for (const lens of S.lenses) {
        const j = judge(lens, f);
        const td = el('td', 'num');
        if (j) {
          const k = el('span', 'k');
          k.style.background = j.color;
          td.append(k, document.createTextNode(lens.type === 'choice' || lens.type === 'score' ? j.label : j.value.toFixed(2)));
        } else {
          td.textContent = '—';
        }
        tr.append(td);
      }
      tr.onclick = () => {
        $('table-modal').hidden = true;
        select(f.id);
      };
      tbody.append(tr);
    }
    table.append(thead, tbody);
  }

  $('btn-table').onclick = () => {
    $('table-modal').hidden = false;
    renderTable();
  };
  $('table-filter').addEventListener('input', renderTable);

  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.hasAttribute('data-close')) m.hidden = true;
    });
  }

  /* ---------------------------------------------------------------- keyboard */

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape') {
      const open = [...document.querySelectorAll('.modal')].find((m) => !m.hidden);
      if (open) open.hidden = true;
      else if (S.pinned) setFocus(S.pinned.test, true, S.pinned.id);
      else if (!zoomOut()) select(null);
      if (typing) document.activeElement.blur();
      return;
    }
    if (typing) return;
    if (e.key === '/') {
      e.preventDefault();
      $('ask-input').focus();
    } else if (e.key === 't') {
      $('btn-table').click();
    } else if (/^[1-9]$/.test(e.key)) {
      const lens = S.lenses[Number(e.key) - 1];
      if (lens) setActive(lens.key);
    }
  });

  /* --------------------------------------------------------------------- misc */

  function toast(message) {
    const t = el('div', 'toast', message);
    document.body.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  /* -------------------------------------------------------------------- live */

  function onAnswer(d) {
    const store = S.answers[d.fileId];
    if (!store) return;
    Object.assign(store, d.answers);
    const keys = Object.keys(d.answers);
    S.ranks = {};
    const active = lensByKey(S.active);
    if (active && active.type === 'composite') S.recolorPending = true;
    else if (affects(active, keys)) updateTile(d.fileId, !d.cached || S.stream.length < 400);
    d.seq = ++S.streamSeq;
    S.stream.unshift(d);
    if (S.stream.length > 60) S.stream.length = 60;
    scheduleUi();
  }

  function connect() {
    const buffer = [];
    let ready = false;
    const es = new EventSource('api/events');
    const on = (name, fn) => es.addEventListener(name, (e) => {
      const data = JSON.parse(e.data);
      if (ready) fn(data);
      else buffer.push([fn, data]);
    });
    on('answer', onAnswer);
    on('lens', (d) => addLens(d.lens));
    on('stats', (s) => {
      S.stats = s;
      S.running = s.running;
      scheduleUi();
    });
    on('status', (d) => {
      S.running = d.phase === 'running';
      scheduleUi();
    });
    on('fatal', (d) => toast(d.message));
    on('fileError', () => {});
    es.onerror = () => {
      S.running = false;
      $('st-dot').className = 'dot';
      $('st-model').textContent = 'offline';
    };
    return {
      flush() {
        ready = true;
        for (const [fn, data] of buffer) fn(data);
        buffer.length = 0;
      },
    };
  }

  async function boot() {
    let link = null;
    let snap = EMBED;
    if (LIVE) {
      link = connect();
      snap = await fetch('api/snapshot').then((r) => r.json());
    }
    load(snap);
    new ResizeObserver(resize).observe($('canvas-wrap'));
    resize();
    if (link) link.flush();
    requestAnimationFrame(frame);
  }

  boot().catch((err) => toast(`Failed to load: ${err.message}`));
})();
