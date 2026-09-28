import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { PRODUCT_PROFILE } from './productProfile';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const readFile = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

const extractYamlScalar = (yaml: string, key: string): string => {
  const match = yaml.match(new RegExp(`^${key}:\\s+(.+)$`, 'm'));
  if (!match?.[1]) throw new Error(`Missing key "${key}" in yaml`);
  return match[1].trim();
};

describe('desktop product profile consistency', () => {
  it('keeps the standard profile aligned with current compatibility identity', () => {
    expect(PRODUCT_PROFILE.appId).toBe('com.billme.desktop');
    expect(PRODUCT_PROFILE.appName).toBe('Billme');
    expect(PRODUCT_PROFILE.productName).toBe('Billme');
    expect(PRODUCT_PROFILE.dbFileName).toBe('billme.sqlite');
    expect(PRODUCT_PROFILE.backupPrefix).toBe('billme');
  });

  it('aligns packaging metadata with product profile', () => {
    const builderYaml = readFile('electron-builder.yml');
    expect(extractYamlScalar(builderYaml, 'appId')).toBe(PRODUCT_PROFILE.appId);
    expect(extractYamlScalar(builderYaml, 'productName')).toBe(PRODUCT_PROFILE.productName);
  });

  it('uses product profile in the desktop main process', () => {
    const mainTs = readFile('electron/main.ts');

    expect(mainTs).toContain('PRODUCT_PROFILE');

    expect(mainTs).not.toContain("'billme-dev'");
    expect(mainTs).not.toContain('initDb(userDataPath)');
  });
});
