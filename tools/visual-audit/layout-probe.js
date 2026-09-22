// Layout-/Darstellungsprobe (VISUAL-AUDIT-PLAN.md §5)
// Aufruf: playwright-cli -s=<session> --raw run-code --filename=tools/visual-audit/layout-probe.js
// Praezisierungen gegenueber dem Plan-Entwurf: CSS-Farben werden per Canvas normalisiert
// (Tailwind v4 liefert oklch/oklab, ein naiver Parser erzeugt Falschpositive), Alpha wird
// ueber den Hintergrund komponiert, und .print-area (gerendertes Dokument) ist wie in
// DESIGN.md dokumentiert von Radius-, Kontrast- und Betragsregeln ausgenommen.
async page => {
  return await page.evaluate(() => {
    const issues = [];
    const vw = window.innerWidth, vh = window.innerHeight;
    const root = document.documentElement;
    const ctx = document.createElement('canvas').getContext('2d');
    const toRgba = (css) => {
      ctx.fillStyle = '#000';
      try { ctx.fillStyle = css; } catch { return [0, 0, 0, 1]; }
      const v = ctx.fillStyle;
      if (v.startsWith('#')) {
        const h = v.length === 4 ? v.slice(1).split('').map((c) => c + c).join('') : v.slice(1);
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
      }
      const m = (v.match(/[\d.]+/g) || ['0', '0', '0']).map(Number);
      return [m[0] | 0, m[1] | 0, m[2] | 0, m[3] === undefined ? 1 : m[3]];
    };
    const label = (el) => {
      const cls = (el.getAttribute('class') || '').split(/\s+/).slice(0, 2).join('.');
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
    };
    const vis = (el) => {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
      if (r.width <= 2 || r.height <= 2) return false;
      return true;
    };
    const srOnly = (el) => /(^|\s)(sr-only|hidden|invisible)(\s|$)/.test(el.getAttribute('class') || '');
    const inPrintArea = (el) => Boolean(el.closest('.print-area'));
    const inInert = (el) => Boolean(el.closest('[inert]'));
    const add = (rule, severity, el, detail, exempt) => {
      if (exempt) return;
      issues.push({ rule, severity, el: typeof el === 'string' ? el : label(el),
        text: typeof el === 'string' ? '' : (el.textContent || '').trim().slice(0, 40), detail });
    };

    if (root.scrollWidth > root.clientWidth + 1)
      add('h-overflow', 'high', 'html', `scrollWidth=${root.scrollWidth} clientWidth=${root.clientWidth}`);

    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el) || srOnly(el) || inInert(el)) continue;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      const scrolls = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
      if (s.position !== 'fixed' && r.width < vw * 0.98 && !scrolls) {
        if (r.right > vw + 1)  add('escapes-right', 'high', el, `right=${Math.round(r.right)} vw=${vw}`);
        if (r.left < -1)       add('escapes-left', 'high', el, `left=${Math.round(r.left)}`);
      }
      if (!el.children.length && (el.textContent || '').trim()) {
        if (el.scrollWidth > el.clientWidth + 1 && s.overflowX === 'hidden' && s.textOverflow !== 'ellipsis')
          add('text-clipped-x', 'medium', el, 'scrollWidth > clientWidth, overflow-x hidden ohne Ellipsis');
        if (el.scrollHeight > el.clientHeight + 2 && s.overflowY === 'hidden')
          add('text-clipped-y', 'medium', el, 'scrollHeight > clientHeight, overflow-y hidden');
      }
      const interactive = el.matches('button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=switch]');
      if (interactive && (r.width < 24 || r.height < 24))
        add('target-too-small', 'medium', el, `${Math.round(r.width)}x${Math.round(r.height)}`);
      const br = parseFloat(s.borderTopLeftRadius || '0');
      if (br > 0 && !inPrintArea(el) && s.position !== 'fixed') {
        const ok = [0, 8, 16, 24, 32, 40, 48].some((v) => Math.abs(br - v) < 0.6) || br >= 1000;
        if (!ok) add('radius-off-scale', 'low', el, `${br}px`);
      }
    }

    const lum = (c) => { const f = c / 255; return f <= 0.03928 ? f / 12.92 : ((f + 0.055) / 1.055) ** 2.4; };
    const rel = (rgb) => 0.2126 * lum(rgb[0]) + 0.7152 * lum(rgb[1]) + 0.0722 * lum(rgb[2]);
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = getComputedStyle(n).backgroundColor;
        const [r, g, b, a] = toRgba(c);
        if (a > 0.95) return [r, g, b];
      }
      return [255, 255, 255];
    };
    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el) || srOnly(el) || inInert(el) || inPrintArea(el) || el.children.length) continue;
      const txt = (el.textContent || '').trim();
      if (!txt) continue;
      const s = getComputedStyle(el);
      const bg = bgOf(el);
      const [fr, fg2, fb, fa] = toRgba(s.color);
      const fg = [Math.round(fr * fa + bg[0] * (1 - fa)), Math.round(fg2 * fa + bg[1] * (1 - fa)), Math.round(fb * fa + bg[2] * (1 - fa))];
      const a = rel(fg), b = rel(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const size = parseFloat(s.fontSize), bold = +s.fontWeight >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const min = large ? 3 : 4.5;
      if (ratio < min) add('contrast', ratio < min - 1 ? 'high' : 'medium', el,
        `${ratio.toFixed(2)}:1 < ${min} (${s.color} auf rgb(${bg.join(',')}))`);
    }

    for (const img of document.images)
      if (img.complete && img.naturalWidth === 0) add('broken-image', 'high', img, img.currentSrc || img.src);

    if (!document.fonts.check('16px Inter')) add('font-fallback', 'medium', 'body', 'Inter nicht geladen');

    for (const el of document.querySelectorAll('body *')) {
      if (!vis(el) || srOnly(el) || inInert(el) || el.children.length || inPrintArea(el)) continue;
      const t = (el.textContent || '').trim();
      if (!/^-?[\d.]{1,12},\d{2}\s?€$/.test(t)) continue;
      const s = getComputedStyle(el);
      if (!/tabular-nums/.test(s.fontVariantNumeric)) add('amount-not-tabular', 'low', el, t);
    }

    for (const el of document.querySelectorAll('[role=dialog], [role=alertdialog], [role=menu], [role=listbox]')) {
      if (el === document.body || !el.closest('body')) continue;
      const box = el.parentElement ?? el;
      if (box.parentElement !== document.body)
        add('overlay-not-portaled', 'medium', el, `parent=${box.parentElement ? label(box.parentElement) : 'none'}`);
      const z = getComputedStyle(box).zIndex;
      if (z !== 'auto' && !['30', '40', '50'].includes(z))
        add('layer-off-token', 'low', el, `z-index=${z}`);
    }

    const counts = issues.reduce((m, i) => (m[i.rule] = (m[i.rule] || 0) + 1, m), {});
    return { url: location.href, vw, vh, issues, counts };
  });
}
