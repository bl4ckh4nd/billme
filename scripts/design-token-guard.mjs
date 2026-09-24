#!/usr/bin/env node
// Design-token guard. Fails when UI source reintroduces a pattern the design
// system has retired, so the fixes in anti-slop/audit-001-2026-09-15.md stay
// fixed. Every rule below names the rule it enforces and the reason.
//
// Run with `pnpm guard:design`. Add `--json` for machine-readable output.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoots = ['apps', 'packages'];

const ignoredDirs = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.git',
  'release',
  'playground',
  '.wrangler',
]);
const ignoredFile = (name) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name);

// Print/PDF document templates and user-customizable canvas colours keep
// self-contained styling on purpose (DESIGN.md "Exemptions").
const exempt = [
  /^packages\/desktop-renderer\/src\/components\/PrintDocument\.tsx$/,
  /^packages\/desktop-renderer\/src\/components\/PrintEurDocument\.tsx$/,
  /^packages\/desktop-designer\/src\/constants\.ts$/,
  /^packages\/accounting-ui-pro\/src\/domain\/reportExport\.ts$/,
  /^packages\/ui\/styles\.css$/,
  /^packages\/ui\/src\/utils\/colors\.ts$/,
];

const rules = [
  {
    id: 'R-02',
    description: 'em dash character in UI source (use EMPTY_VALUE or prose punctuation)',
    pattern: /\u2014/g,
  },
  {
    id: 'R-29',
    description: 'raw hex colour in a Tailwind utility (use a design token)',
    pattern: /(?:bg|text|border|ring|fill|stroke|divide|from|to|via|shadow)-\[#[0-9a-fA-F]{3,8}\]/g,
  },
  {
    id: 'R-29',
    description: 'default gray/slate/zinc/neutral palette utility in app chrome (use a token)',
    pattern: /(?:bg|text|border|ring|divide|from|to|via|placeholder:text)-(?:gray|slate|zinc|neutral|stone)-\d{2,3}/g,
  },
  {
    id: 'R-11',
    description: 'arbitrary border radius (use the declared radius scale)',
    pattern: /rounded(?:-[trblse]){0,2}-\[[^\]]+\]/g,
  },
  {
    id: 'R-01',
    description: 'gradient used as a default surface treatment',
    pattern: /\bbg-gradient-to-[trbl]{1,2}\b|(?:radial|conic)-gradient\(/g,
  },
  {
    id: 'R-13',
    description: 'glow (blurred orb, coloured halo shadow, glow keyframe)',
    pattern: /blur-\[\d{2,3}px\]|shadow-\[0_0_[^\]]*\]|shadow-(?:accent|error|success|warning|info)\/\d+|pulse-glow/g,
  },
  {
    id: 'R-10',
    description: 'glassmorphism outside a modal scrim',
    pattern: /backdrop-blur-[a-z0-9]+/g,
    // A scrim is `fixed inset-0` (or a positioned inset-0 overlay). Anywhere else
    // blur is decorative.
    skipLine: /inset-0/,
  },
  {
    id: 'R-06',
    description: 'off-scale micro font size (12px is the floor)',
    pattern: /text-\[(?:[0-9]|1[01])px\]/g,
    // The designer's billing-row editor positions labels inside authored A4
    // elements sized by the template, where 12px would reflow the page. Its
    // 10px and 11px labels carry file-level comments; 8px and 9px stay banned.
    allow: [
      /^packages\/desktop-designer\/src\/document-editor\/DocumentCanvasEditor\.tsx$/,
      /^packages\/desktop-designer\/src\/CanvasStage\.tsx$/,
      /^packages\/desktop-designer\/src\/Rulers\.tsx$/,
      // Template chrome rendered at authored A4 scale (placeholder + GIROCODE label).
      /^packages\/desktop-designer\/src\/ElementRenderer\.tsx$/,
    ],
    allowPattern: /text-\[1[01]px\]/,
  },
  {
    id: 'R-32',
    description: 'focus outline removed without a replacement',
    pattern: /(?<!focus-visible:)(?<!focus:)\boutline-none\b/g,
  },
  {
    id: 'R-19',
    description: 'decorative entrance animation (MOTION 1 allows interaction feedback only)',
    pattern: /\banimate-(?:enter|scale-in|fade-in|in)\b|\bpremium-hover\b|slide-in-from-|zoom-in-\d|animationDelay/g,
  },
  {
    id: 'R-19b',
    description: 'motion-affecting transition without its own motion-reduce guard (MOTION 1 bans decorative/layout motion; plain transition-colors interaction feedback stays allowed)',
    pattern: /transition-(?:all|opacity|transform|\[)|active:scale-95/g,
    // Guarded lines carry motion-reduce:transition-none (or motion-safe: + motion-reduce:) on the same attribute.
    skipLine: /motion-reduce/,
  },
  {
    id: 'R-31',
    description: 'overlay z-index literal instead of the layer token',
    pattern: /\bz-(?:40|50|\[9{3,}\])\b|zIndex:\s*9{3,}/g,
    skipLine: /drag-region/,
  },
  {
    id: 'R-25',
    description: 'accent used as text or focus indicator on a light surface',
    pattern: /\btext-accent\b(?!-)|focus(?:-visible)?:border-accent/g,
    // Lime on the near-black ramp is sanctioned (accent-foreground pairing).
    skipLine: /bg-dark-|bg-black|bg-\[#0|bg-\[#1|text-dark-|fill-black/,
    // Surfaces that are dark by design, where the accent is the correct
    // foreground. Each file was checked: the flagged sites all sit inside a
    // `bg-dark-3` or `bg-dark-base` parent.
    skipFile: [
      /^packages\/ui\/src\/components\/AuthScreen\.tsx$/, // dark brand panel (aside, bg-dark-base)
      /^packages\/desktop-ui\/src\/shell\/DashboardViews\.tsx$/, // dark-3 KPI card
      /^packages\/desktop-ui\/src\/shell\/StatisticsView\.tsx$/, // dark-3 revenue card
      /^packages\/desktop-designer\/src\/LayersPanel\.tsx$/, // dark rail
      /^apps\/landing-page\/src\/App\.tsx$/, // dark screenshots frame, GoBD band, CTA card
      /^packages\/ui\/src\/components\/FeedbackProvider\.tsx$/, // toast icons, Toast is bg-surface-inverse
      /^packages\/ui\/src\/components\/Sparkline\.tsx$/, // lime only in the `inverse` variant, used on surface-inverse
    ],
  },
  {
    id: 'P-01',
    description: 'font-black in product UI (DESIGN.md Typography: weights are 400/500/600, bold only for figures)',
    pattern: /\bfont-black\b/g,
    // The marketing site keeps its own display scale.
    skipFile: [/^apps\/landing-page\//],
  },
  {
    id: 'P-02',
    description: 'transition on a layout property (animate transform or opacity; disclosure height uses the sanctioned accordion utility)',
    pattern: /transition-\[(?:[\w-]+,)*(?:width|height|top|left|right|bottom|margin|padding)[\],]/g,
    // SegmentedControl's thumb is absolutely positioned, so its width change
    // reflows nothing; it is the one sanctioned exception.
    skipFile: [/^packages\/ui\/src\/components\/SegmentedControl\.tsx$/],
  },
  {
    id: 'P-03',
    description: 'raw <table> in app chrome (use Table from @billme/ui: sticky header, numeric cells, row states)',
    pattern: /<table\b/g,
    skipFile: [
      /^packages\/ui\//, // the primitive itself and BarChart's screen-reader table
      /^packages\/desktop-designer\/src\/ElementRenderer\.tsx$/, // customer document content, user-styled
      /^apps\/offer-portal\//, // server-rendered HTML, no React
    ],
  },
  {
    id: 'P-04',
    description: 'icon size off the scale (12 caption, 14, 16 default, 20; 24/32/48 for illustrations)',
    pattern: /\bsize=\{(?!(?:12|14|16|20|24|32|48)\})\d+\}/g,
    // The marketing site keeps its own display scale.
    skipFile: [/^apps\/landing-page\//],
  },
];

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (/\.(?:[cm]?[jt]sx?|css)$/.test(entry.name) && !ignoredFile(entry.name)) files.push(path);
  }
  return files;
}

const violations = [];
for (const sourceRoot of sourceRoots) {
  for (const file of await collect(join(root, sourceRoot))) {
    const relativePath = relative(root, file).replaceAll('\\', '/');
    if (exempt.some((entry) => entry.test(relativePath))) continue;
    const source = await readFile(file, 'utf8');
    const lines = source.split('\n');
    for (const rule of rules) {
      if (rule.skipFile?.some((entry) => entry.test(relativePath))) continue;
      const allowed = rule.allow?.some((entry) => entry.test(relativePath));
      for (const match of source.matchAll(rule.pattern)) {
        const line = source.slice(0, match.index).split('\n').length;
        const lineText = lines[line - 1] ?? '';
        if (rule.skipLine?.test(lineText)) continue;
        if (allowed && rule.allowPattern?.test(match[0])) continue;
        violations.push({
          file: relativePath,
          line,
          rule: rule.id,
          description: rule.description,
          evidence: lineText.trim().slice(0, 140),
        });
      }
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ violations }, null, 2));
} else if (violations.length) {
  const byRule = new Map();
  for (const violation of violations) {
    const list = byRule.get(violation.rule) ?? [];
    list.push(violation);
    byRule.set(violation.rule, list);
  }
  console.error(`Design-token guard failed with ${violations.length} violation(s).`);
  for (const [rule, list] of byRule) {
    console.error(`\n${rule}: ${list[0].description} (${list.length})`);
    for (const violation of list.slice(0, 20)) {
      console.error(`  ${violation.file}:${violation.line}  ${violation.evidence}`);
    }
    if (list.length > 20) console.error(`  ... and ${list.length - 20} more`);
  }
  process.exitCode = 1;
} else {
  console.log(`Design-token guard passed (${rules.length} rules, ${exempt.length} exempt paths).`);
}
