// Nested squarified treemap (Bruls, Huizing & van Wijk). Classic script.
(function (root) {
  'use strict';

  // Directory tree from flat file records. Single-child directory chains are
  // collapsed ("src/lib/core") so deep layouts do not waste space on headers.
  function buildTree(files, sizeOf) {
    const top = { name: '', path: '', dirs: new Map(), files: [] };
    for (const f of files) {
      let node = top;
      if (f.dir) {
        for (const part of f.dir.split('/')) {
          if (!node.dirs.has(part)) {
            node.dirs.set(part, { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: new Map(), files: [] });
          }
          node = node.dirs.get(part);
        }
      }
      node.files.push(f);
    }

    function finalize(node, isRoot) {
      let children = [...node.dirs.values()].map((d) => finalize(d, false));
      children = children.concat(node.files.map((f) => ({ file: f, value: sizeOf(f) })));
      const out = { name: node.name, path: node.path, children, value: children.reduce((s, c) => s + c.value, 0) };
      if (!isRoot && children.length === 1 && !children[0].file) {
        const only = children[0];
        return { ...only, name: `${node.name}/${only.name}` };
      }
      return out;
    }
    return finalize(top, true);
  }

  function findNode(tree, path) {
    if (!path) return tree;
    const stack = [tree];
    while (stack.length) {
      const node = stack.pop();
      if (node.path === path) return node;
      for (const c of node.children || []) if (!c.file) stack.push(c);
    }
    return tree;
  }

  function worst(areas, side) {
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const a of areas) {
      sum += a;
      if (a > max) max = a;
      if (a < min) min = a;
    }
    const s2 = side * side;
    const sum2 = sum * sum;
    return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
  }

  function squarify(items, x, y, w, h, out) {
    const total = items.reduce((s, it) => s + it.value, 0);
    if (total <= 0 || w <= 0 || h <= 0) return;
    const scale = (w * h) / total;
    let rest = items.map((it) => ({ it, area: it.value * scale }));
    while (rest.length) {
      const side = Math.min(w, h);
      let count = 1;
      let current = worst([rest[0].area], side);
      while (count < rest.length) {
        const next = worst(rest.slice(0, count + 1).map((r) => r.area), side);
        if (next > current) break;
        current = next;
        count++;
      }
      const row = rest.slice(0, count);
      const rowArea = row.reduce((s, r) => s + r.area, 0);
      if (w >= h) {
        const cw = rowArea / h;
        let cy = y;
        for (const r of row) {
          const rh = r.area / cw;
          out.push({ item: r.it, x, y: cy, w: cw, h: rh });
          cy += rh;
        }
        x += cw;
        w -= cw;
      } else {
        const rh = rowArea / w;
        let cx = x;
        for (const r of row) {
          const rw = r.area / rh;
          out.push({ item: r.it, x: cx, y, w: rw, h: rh });
          cx += rw;
        }
        y += rh;
        h -= rh;
      }
      rest = rest.slice(count);
    }
  }

  function layout(node, rect, opts) {
    const pad = opts.pad ?? 3;
    const header = opts.header ?? 16;
    const tiles = [];
    const groups = [];

    function place(n, x, y, w, h, depth) {
      const kids = n.children.filter((k) => k.value > 0).sort((a, b) => b.value - a.value);
      const cells = [];
      squarify(kids, x, y, w, h, cells);
      for (const c of cells) {
        if (c.item.file) {
          tiles.push({ file: c.item.file, x: c.x, y: c.y, w: c.w, h: c.h, depth });
          continue;
        }
        const roomy = c.w > 14 && c.h > 14;
        const labelled = c.w > 64 && c.h > 44;
        const g = { node: c.item, x: c.x, y: c.y, w: c.w, h: c.h, depth, header: labelled ? header : 0 };
        groups.push(g);
        const p = roomy ? pad : 0;
        place(c.item, c.x + p, c.y + p + g.header, Math.max(0, c.w - 2 * p), Math.max(0, c.h - 2 * p - g.header), depth + 1);
      }
    }

    place(node, rect.x, rect.y, rect.w, rect.h, 0);
    return { tiles, groups };
  }

  root.XTreemap = { buildTree, findNode, layout, squarify };
})(typeof window !== 'undefined' ? window : globalThis);
