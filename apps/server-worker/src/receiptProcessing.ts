import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  claimQueuedPostgresReceipts,
  enqueueMobilePush,
  updatePostgresReceipt,
  type PostgresQueryable,
} from '@billme/server-data';
import { receiptSuggestionSchema, type Receipt, type ReceiptSuggestion } from '@billme/server-core';
import type { Pool } from 'pg';

const execFileAsync = promisify(execFile);
const amountPattern = /(?:EUR|€)?\s*(-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+[.,]\d{2})\s*(?:EUR|€)?/gi;

const parseAmount = (value: string): number | null => {
  const normalized = value.replace(/[€\s]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
};

const amountsOnLine = (line: string): number[] => [...line.matchAll(amountPattern)]
  .map((match) => parseAmount(match[1] ?? ''))
  .filter((amount): amount is number => amount !== null);

const firstMatch = (lines: string[], pattern: RegExp): { value: string; line: string } | null => {
  for (const line of lines) {
    const match = pattern.exec(line);
    pattern.lastIndex = 0;
    if (match?.[1]) return { value: match[1].trim(), line };
  }
  return null;
};

export const normalizeReceiptDate = (value: string): string | null => {
  const match = /^(\d{2})[./-](\d{2})[./-](\d{4})$/.exec(value.trim());
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
};

const amountNear = (lines: string[], labels: RegExp): { value: number; line: string } | null => {
  for (const line of lines) {
    labels.lastIndex = 0;
    if (!labels.test(line)) continue;
    const amounts = amountsOnLine(line);
    if (amounts.length > 0) return { value: amounts.at(-1)!, line };
  }
  return null;
};

export const extractReceiptSuggestion = (rawText: string, suggestedAccountNumber?: string): ReceiptSuggestion => {
  const lines = rawText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const merchant = lines.find((line) =>
    line.length >= 2 && line.length <= 100 && !/(rechnung|beleg|quittung|datum|www\.|tel\.|ust-?id)/i.test(line)
  ) ?? null;
  const date = firstMatch(lines, /\b(\d{2}[./-]\d{2}[./-]\d{4}|\d{4}-\d{2}-\d{2})\b/);
  const invoiceNumber = firstMatch(lines, /(?:rechnung(?:snummer)?(?:\s*[-.]?\s*nr\.?)?|beleg(?:nummer|nr\.?)|invoice\s*no\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9/_-]{2,})/i);
  const gross = amountNear(lines, /\b(gesamt(?:betrag)?|summe|zu\s+zahlen|endbetrag|total)\b/i);
  const net = amountNear(lines, /\b(netto|net\s+amount)\b/i);
  const vat = amountNear(lines, /\b(mwst\.?|ust\.?|umsatzsteuer|vat)\b/i);
  const allAmounts = lines.flatMap(amountsOnLine);
  const grossFallback = allAmounts.length > 0 ? Math.max(...allAmounts) : null;
  const field = <T>(value: T | null, confidence: number, sourceText?: string) => ({ value, confidence, sourceText });
  return receiptSuggestionSchema.parse({
    merchant: field(merchant, merchant ? 0.65 : 0, merchant ?? undefined),
    invoiceNumber: field(invoiceNumber?.value ?? null, invoiceNumber ? 0.9 : 0, invoiceNumber?.line),
    date: field(date ? normalizeReceiptDate(date.value) : null, date ? 0.85 : 0, date?.line),
    currency: field('EUR', /(?:EUR|€)/i.test(rawText) ? 0.95 : 0.55),
    grossAmount: field(gross?.value ?? grossFallback, gross ? 0.9 : grossFallback !== null ? 0.45 : 0, gross?.line),
    netAmount: field(net?.value ?? null, net ? 0.85 : 0, net?.line),
    vatAmount: field(vat?.value ?? null, vat ? 0.8 : 0, vat?.line),
    suggestedAccountNumber: suggestedAccountNumber
      ? field(suggestedAccountNumber, 0.8)
      : undefined,
    rawText: rawText.slice(0, 100_000),
  });
};

const run = async (command: string, args: string[]): Promise<string> => {
  const result = await execFileAsync(command, args, {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
};

const readReceiptText = async (receipt: Receipt, storageRoot: string): Promise<string> => {
  const path = join(storageRoot, receipt.storageKey);
  if (receipt.mimeType !== 'application/pdf') {
    return run('tesseract', [path, 'stdout', '-l', 'deu+eng', '--psm', '6']);
  }
  const info = await run('pdfinfo', [path]);
  const pages = Number(/^Pages:\s+(\d+)/mi.exec(info)?.[1] ?? 0);
  if (!Number.isInteger(pages) || pages < 1 || pages > 10) throw new Error('RECEIPT_PAGE_LIMIT');
  const text = await run('pdftotext', ['-layout', '-f', '1', '-l', '10', path, '-']);
  if (text.trim().length >= 20) return text;
  const temp = await mkdtemp(join(tmpdir(), 'billme-ocr-'));
  try {
    const prefix = join(temp, 'page');
    await run('pdftoppm', ['-jpeg', '-r', '200', '-f', '1', '-l', String(pages), path, prefix]);
    const chunks: string[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const pagePath = `${prefix}-${page}.jpg`;
      await readFile(pagePath);
      chunks.push(await run('tesseract', [pagePath, 'stdout', '-l', 'deu+eng', '--psm', '6']));
    }
    return chunks.join('\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
};

const findSuggestedAccount = async (db: PostgresQueryable, receipt: Receipt, text: string): Promise<string | undefined> => {
  if (receipt.product !== 'pro') return undefined;
  const normalized = text.toLocaleLowerCase('de-DE');
  const result = await db.query<{ target_account_number: string; field: string; operator: string; value: string }>(
    `SELECT target_account_number, field, operator, value FROM account_suggestion_rules
     WHERE tenant_id = $1 AND active = TRUE AND flow_type IN ('expense', 'any')
     ORDER BY priority ASC, updated_at DESC`,
    [receipt.tenantId],
  );
  return result.rows.find((rule) => {
    const value = rule.value.toLocaleLowerCase('de-DE');
    return rule.operator === 'equals' ? normalized === value
      : rule.operator === 'startsWith' ? normalized.startsWith(value)
      : normalized.includes(value);
  })?.target_account_number;
};

export const processReceiptBatch = async (
  pool: Pool,
  storageRoot: string,
  log: (message: string, details?: Record<string, unknown>) => void,
): Promise<{ processed: number; failed: number }> => {
  const receipts = await claimQueuedPostgresReceipts(pool, 5);
  let processed = 0;
  let failed = 0;
  for (const receipt of receipts) {
    try {
      const rawText = await readReceiptText(receipt, storageRoot);
      if (rawText.trim().length < 4) throw new Error('OCR_EMPTY');
      const account = await findSuggestedAccount(pool, receipt, rawText);
      await updatePostgresReceipt(pool, receipt.tenantId, receipt.id, {
        status: 'needs_review',
        suggestion: extractReceiptSuggestion(rawText, account),
      });
      await enqueueMobilePush(pool, {
        tenantId: receipt.tenantId,
        product: receipt.product,
        title: 'Receipt ready to review',
        body: 'Open Billme to check the extracted fields.',
        route: `/receipts/${receipt.id}`,
      });
      processed += 1;
      log('Receipt extraction completed', { receiptId: receipt.id, tenantId: receipt.tenantId });
    } catch (error) {
      failed += 1;
      const code = error instanceof Error ? error.message.slice(0, 120) : 'OCR_FAILED';
      await updatePostgresReceipt(pool, receipt.tenantId, receipt.id, { status: 'failed', failureCode: code });
      log('Receipt extraction failed', { receiptId: receipt.id, tenantId: receipt.tenantId, error: code });
    }
  }
  return { processed, failed };
};
