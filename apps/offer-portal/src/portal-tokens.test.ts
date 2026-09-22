import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { colors } from '../../../packages/ui/src/utils/colors';
import { PORTAL_TOKENS } from './app';

const here = dirname(fileURLToPath(import.meta.url));
const stylesCss = await readFile(join(here, '../../../packages/ui/styles.css'), 'utf8');
const cssVar = (name: string) => {
  const match = stylesCss.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `packages/ui/styles.css declares --${name}`);
  return match[1].trim();
};

/* The portal renders straight from Node without a build step and cannot import
   @billme/ui, so PORTAL_TOKENS mirrors the canonical values. This test keeps
   the mirror honest: every entry must equal colors.ts and styles.css. */
test('PORTAL_TOKENS mirrors the canonical design tokens', () => {
  assert.equal(PORTAL_TOKENS.surface, colors.surface);
  assert.equal(PORTAL_TOKENS.surface, cssVar('color-surface'));
  assert.equal(PORTAL_TOKENS.surfaceSunken, colors.surfaceSunken);
  assert.equal(PORTAL_TOKENS.surfaceSunken, cssVar('color-surface-sunken'));
  assert.equal(PORTAL_TOKENS.foreground, colors.foreground);
  assert.equal(PORTAL_TOKENS.foreground, cssVar('color-foreground'));
  assert.equal(PORTAL_TOKENS.muted, colors.muted);
  assert.equal(PORTAL_TOKENS.muted, cssVar('color-muted'));
  assert.equal(PORTAL_TOKENS.border, colors.border);
  assert.equal(PORTAL_TOKENS.border, cssVar('color-border'));
  assert.equal(PORTAL_TOKENS.controlBorder, colors.controlBorder);
  assert.equal(PORTAL_TOKENS.controlBorder, cssVar('color-control-border'));
  assert.equal(PORTAL_TOKENS.accent, colors.accent);
  assert.equal(PORTAL_TOKENS.accent, cssVar('color-accent'));
  assert.equal(PORTAL_TOKENS.accentForeground, colors.accentForeground);
  assert.equal(PORTAL_TOKENS.accentForeground, cssVar('color-accent-foreground'));
  assert.equal(PORTAL_TOKENS.focusRing, colors.focusRing);
  assert.equal(PORTAL_TOKENS.focusRing, cssVar('color-focus-ring'));
  assert.equal(PORTAL_TOKENS.successText, colors.successText);
  assert.equal(PORTAL_TOKENS.successText, cssVar('color-success-text'));
  assert.equal(PORTAL_TOKENS.warningText, colors.warningText);
  assert.equal(PORTAL_TOKENS.warningText, cssVar('color-warning-text'));
  assert.equal(PORTAL_TOKENS.warningBg, colors.warningBg);
  assert.equal(PORTAL_TOKENS.warningBg, cssVar('color-warning-bg'));
  assert.equal(PORTAL_TOKENS.warningBorder, colors.warningBorder);
  assert.equal(PORTAL_TOKENS.warningBorder, cssVar('color-warning-border'));
  assert.equal(PORTAL_TOKENS.errorText, colors.errorText);
  assert.equal(PORTAL_TOKENS.errorText, cssVar('color-error-text'));
  assert.equal(PORTAL_TOKENS.radiusSm, cssVar('radius-sm'));
  assert.equal(PORTAL_TOKENS.radiusMd, cssVar('radius-md'));
  assert.equal(PORTAL_TOKENS.radiusLg, cssVar('radius-lg'));
});
