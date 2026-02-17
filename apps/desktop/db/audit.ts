import crypto from 'crypto';
import type Database from 'better-sqlite3';

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',');
  return `{${body}}`;
};

const sha256Hex = (input: string): string => {
  return crypto.createHash('sha256').update(input).digest('hex');
};

export interface AuditWriteParams {
  entityType: 'invoice' | 'offer' | string;
  entityId: string;
  action: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  actor?: string;
  ts?: string;
}

export const appendAuditLog = (db: Database.Database, params: AuditWriteParams) => {
  const ts = params.ts ?? new Date().toISOString();
  const actor = params.actor ?? 'local';

  const prev = db
    .prepare('SELECT sequence, hash FROM audit_log ORDER BY sequence DESC LIMIT 1')
    .get() as { sequence?: number; hash?: string } | undefined;

  const prevSequence = prev?.sequence ?? 0;
  const nextSequence = prevSequence + 1;
  const prevHash = prev?.hash ?? null;

  const payload = {
    sequence: nextSequence,
    ts,
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    reason: params.reason ?? null,
    before: params.before ?? null,
    after: params.after ?? null,
    prevHash,
    actor,
  };

  const payloadStr = stableStringify(payload);
  const hash = sha256Hex(`${prevHash ?? ''}:${payloadStr}`);

  db.prepare(
    `
      INSERT INTO audit_log (
        sequence, ts, entity_type, entity_id, action, reason,
        before_json, after_json, prev_hash, hash, actor
      ) VALUES (
        @sequence, @ts, @entityType, @entityId, @action, @reason,
        @beforeJson, @afterJson, @prevHash, @hash, @actor
      )
    `,
  ).run({
    sequence: nextSequence,
    ts,
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    reason: params.reason ?? null,
    beforeJson: params.before ? stableStringify(params.before) : null,
    afterJson: params.after ? stableStringify(params.after) : null,
    prevHash,
    hash,
    actor,
  });

  return { sequence: nextSequence, hash };
};

export const verifyAuditChain = (db: Database.Database) => {
  const rows = db
    .prepare(
      `SELECT sequence, ts, entity_type, entity_id, action, reason,
              before_json, after_json, prev_hash, hash, actor
       FROM audit_log
       ORDER BY sequence ASC`,
    )
    .all() as Array<{
    sequence: number;
    ts: string;
    entity_type: string;
    entity_id: string;
    action: string;
    reason: string | null;
    before_json: string | null;
    after_json: string | null;
    prev_hash: string | null;
    hash: string;
    actor: string;
  }>;

  const errors: Array<{ sequence: number; message: string }> = [];
  let expectedPrevHash: string | null = null;

  for (const row of rows) {
    if ((row.prev_hash ?? null) !== expectedPrevHash) {
      errors.push({
        sequence: row.sequence,
        message: `prev_hash mismatch (expected ${expectedPrevHash ?? 'null'})`,
      });
    }

    const before = row.before_json ? JSON.parse(row.before_json) : null;
    const after = row.after_json ? JSON.parse(row.after_json) : null;

    const payload = {
      sequence: row.sequence,
      ts: row.ts,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      reason: row.reason ?? null,
      before,
      after,
      prevHash: row.prev_hash ?? null,
      actor: row.actor,
    };

    const payloadStr = stableStringify(payload);
    const computed = sha256Hex(`${row.prev_hash ?? ''}:${payloadStr}`);
    if (computed !== row.hash) {
      errors.push({ sequence: row.sequence, message: 'hash mismatch' });
    }

    expectedPrevHash = row.hash;
  }

  return {
    ok: errors.length === 0,
    errors,
    count: rows.length,
    headHash: expectedPrevHash,
  };
};

const csvEscape = (value: unknown): string => {
  const str = value === null || value === undefined ? '' : String(value);
  const escaped = str.replace(/\"/g, '""');
  return `"${escaped}"`;
};

export const exportAuditCsv = (db: Database.Database) => {
  const rows = db
    .prepare(
      `SELECT sequence, ts, entity_type, entity_id, action, reason,
              prev_hash, hash, actor, before_json, after_json
       FROM audit_log
       ORDER BY sequence ASC`,
    )
    .all() as Array<Record<string, unknown>>;

  const header = [
    'sequence',
    'ts',
    'entity_type',
    'entity_id',
    'action',
    'reason',
    'prev_hash',
    'hash',
    'actor',
    'before_json',
    'after_json',
  ];

  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      header
        .map((k) => csvEscape(r[k]))
        .join(','),
    );
  }

  // Excel-friendly UTF-8 BOM
  return `\uFEFF${lines.join('\n')}`;
};
