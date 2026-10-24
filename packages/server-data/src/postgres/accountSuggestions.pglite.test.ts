import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { loadAccountSuggestionContext } from './accountSuggestions.js';

const now = '2026-08-21T10:00:00.000Z';
const scopeA = createSingleTenantScope('tenant-a', 'pro');
const scopeB = createSingleTenantScope('tenant-b', 'pro');
const scopeC = createSingleTenantScope('tenant-c', 'pro');

const seed = async (database: PgliteServerDatabase): Promise<void> => {
  await database.query(
    `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
     VALUES ('tenant-a','tenant-a','A','pro',$1,$1),('tenant-b','tenant-b','B','pro',$1,$1),('tenant-c','tenant-c','C','pro',$1,$1)`,
    [now],
  );
  await database.query(
    `INSERT INTO accounting_policies (tenant_id, active_chart, updated_at) VALUES ('tenant-a','SKR03',$1),('tenant-b','SKR04',$1)`,
    [now],
  );
  await database.query(
    `INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at)
     VALUES ('t-skr03-4920','SKR03','4920','Telefon','test',$1,$1),
            ('t-skr03-4930','SKR03','4930','Buero','test',$1,$1),
            ('t-skr03-4940','SKR03','4940','Zeitschriften','test',$1,$1),
            ('t-skr04-6805','SKR04','6805','Telefon','test',$1,$1)
     ON CONFLICT (chart, account_number) DO NOTHING`,
    [now],
  );
  await database.query(
    `INSERT INTO account_suggestion_rules (id,tenant_id,chart,priority,field,operator,value,target_account_number,flow_type,active,created_at,updated_at)
     VALUES ('r-late','tenant-a','SKR03',20,'any','contains','buero','4930','expense',true,$1,$1),
            ('r-first','tenant-a','SKR03',5,'counterparty','equals','Telekom','4920','any',true,$1,$1),
            ('r-off','tenant-a','SKR03',1,'any','contains','off','4940','any',false,$1,$1),
            ('r-skr04','tenant-a','SKR04',1,'any','contains','skr04','6805','any',true,$1,$1),
            ('r-b','tenant-b','SKR04',1,'any','contains','tenant-b','6805','any',true,$1,$1)`,
    [now],
  );
  await database.query(
    `INSERT INTO account_keywords (id,tenant_id,chart,account_number,keyword,source,active,created_at,updated_at)
     VALUES ('k-on','tenant-a','SKR03','4920','Mobilfunk','test',true,$1,$1),
            ('k-off','tenant-a','SKR03','4930','Papier','test',false,$1,$1),
            ('k-skr04','tenant-a','SKR04','6805','Mobilfunk','test',true,$1,$1),
            ('k-b','tenant-b','SKR04','6805','Telefon','test',true,$1,$1)`,
    [now],
  );
  await database.query(
    `INSERT INTO accounts (id,tenant_id,name,iban,balance,type,color) VALUES ('acc-a','tenant-a','Bank','DE00',0,'checking','#000'),('acc-b','tenant-b','Bank','DE00',0,'checking','#000')`,
  );
  await database.query(
    `INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,status,created_at,updated_at)
     VALUES ('bt-old','tenant-a','acc-a','2026-01-01',-10,'expense','Telekom','Vertrag','booked',$1,$1),
            ('bt-new','tenant-a','acc-a','2026-02-01',-10,'expense','Telekom','Vertrag','booked',$1,$1),
            ('bt-draft','tenant-a','acc-a','2026-02-02',-10,'expense','Entwurf GmbH','x','open',$1,$1),
            ('bt-rev','tenant-a','acc-a','2026-02-03',-10,'expense','Storno GmbH','x','booked',$1,$1),
            ('bt-b','tenant-b','acc-b','2026-02-01',-10,'expense','Fremd GmbH','x','booked',$1,$1)`,
    [now],
  );
  const bookings: Array<[string, string, string, string, string, string, string]> = [
    ['old', 'tenant-a', 'bt-old', '4930', 'posted', '2026-01-02T00:00:00.000Z', '1'],
    ['new', 'tenant-a', 'bt-new', '4920', 'posted', '2026-02-02T00:00:00.000Z', '2'],
    ['draft', 'tenant-a', 'bt-draft', '4930', 'draft', '2026-02-03T00:00:00.000Z', '3'],
    ['rev', 'tenant-a', 'bt-rev', '4930', 'reversed', '2026-02-04T00:00:00.000Z', '4'],
    ['b', 'tenant-b', 'bt-b', '4125', 'posted', '2026-02-05T00:00:00.000Z', '5'],
  ];
  for (const [id, tenantId, transactionId, account, status, createdAt, entryNumber] of bookings) {
    await database.query(
      `INSERT INTO booking_drafts (id,tenant_id,transaction_id,workflow_status,draft_json,updated_at) VALUES ($1,$2,$3,'posted','{}',$4)`,
      [`draft-${id}`, tenantId, transactionId, createdAt],
    );
    await database.transaction({}, async (tx) => {
    await tx.query(
      `INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,booking_text,period,fiscal_year,status,source_draft_id,created_at)
       VALUES ($1,$2,$3,'2026-02-01','Buchung','2026-02',2026,$4,$5,$6)`,
      [`entry-${id}`, tenantId, Number(entryNumber), status, `draft-${id}`, createdAt],
    );
    await tx.query(
      `INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount)
       VALUES ($1,$2,$3,1,$4,10,0),($5,$2,$3,2,'1200',0,10)`,
      [`line-${id}-1`, tenantId, `entry-${id}`, account, `line-${id}-2`],
    );
    });
  }
};

test('loadAccountSuggestionContext scopes rules, keywords, memory, and chart to the tenant policy', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-suggestions-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await seed(database);

    const ctx = await loadAccountSuggestionContext(database, scopeA);
    assert.equal(ctx.chart, 'SKR03');
    assert.deepEqual(ctx.rules.map((rule) => [rule.value, rule.targetAccountNumber, rule.priority]), [
      ['Telekom', '4920', 5],
      ['buero', '4930', 20],
    ]);
    assert.deepEqual([...ctx.keywordMap.entries()], [['mobilfunk', ['4920']]]);
    assert.deepEqual([...ctx.counterpartyMemory.entries()], [['telekom', '4920']]);
    assert.equal(ctx.bayesModel, null);

    const minAccount = async (chart: string, pattern: string) => (await database.query<{ n: string }>(
      `SELECT MIN(account_number) AS n FROM ledger_accounts WHERE chart = $1 AND account_number ~ $2`,
      [chart, pattern],
    )).rows[0]?.n;
    assert.equal(ctx.fallbackIncomeAccount, await minAccount('SKR03', '^[89]'));
    assert.equal(ctx.fallbackExpenseAccount, await minAccount('SKR03', '^[4-7]'));

    const ctxB = await loadAccountSuggestionContext(database, scopeB);
    assert.equal(ctxB.chart, 'SKR04');
    assert.deepEqual(ctxB.rules.map((rule) => rule.value), ['tenant-b']);
    assert.deepEqual([...ctxB.keywordMap.keys()], ['telefon']);
    assert.deepEqual([...ctxB.counterpartyMemory.entries()], [['fremd gmbh', '4125']]);
    assert.equal(ctxB.fallbackExpenseAccount, await minAccount('SKR04', '^[4-7]'));

    const ctxC = await loadAccountSuggestionContext(database, scopeC);
    assert.equal(ctxC.chart, 'SKR03');
    assert.deepEqual(ctxC.rules, []);
    assert.equal(ctxC.counterpartyMemory.size, 0);
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
