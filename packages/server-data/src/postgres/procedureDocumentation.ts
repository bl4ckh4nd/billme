import type { PostgresQueryable } from './connection.js';
import { verifyPostgresAuditChain } from './audit.js';

/**
 * Draft of a Verfahrensdokumentation (GoBD Rz. 151 ff.) for billme Pro, in the four parts of the AWV sample:
 * allgemeine Beschreibung, Anwender-, technische System- und Betriebsdokumentation. Everything the books and
 * settings know is filled in as of `today`; what only the business can describe (internes Kontrollsystem,
 * Scanprozess, Zuständigkeiten) is listed as open. It is a draft the business completes and signs, not a finished document.
 */
export const buildProcedureDocumentation = async (db: PostgresQueryable, tenantId: string, today: string): Promise<string> => {
  const one = async <T>(text: string): Promise<T | undefined> => (await db.query(text, [tenantId])).rows[0] as T | undefined;
  const raw = (await one<{ settings_json: string }>('SELECT settings_json FROM server_settings WHERE tenant_id=$1 LIMIT 1'))?.settings_json;
  const s = (() => { try { return JSON.parse(String(raw ?? 'null')) ?? {}; } catch { return {}; } })() as {
    company?: { name?: string; owner?: string; street?: string; zip?: string; city?: string };
    finance?: { taxId?: string; vatId?: string };
    numbers?: { invoicePrefix?: string; offerPrefix?: string; customerPrefix?: string };
    legal?: { smallBusinessRule?: boolean };
    businessReportingProfile?: { legalForm?: string; profitDetermination?: string; fiscalYearStart?: string };
  };
  const policy = await one<{ active_chart: string; vat_method: string }>('SELECT active_chart,vat_method FROM accounting_policies WHERE tenant_id=$1');
  const closed = (await db.query("SELECT period FROM accounting_periods WHERE tenant_id=$1 AND status='closed' ORDER BY period", [tenantId])).rows as Array<{ period: string }>;
  const count = async (table: string, where = '') => Number((await one<{ n: string }>(`SELECT COUNT(*) n FROM ${table} WHERE tenant_id=$1${where}`))?.n ?? 0);
  const [entries, receipts, datevExports, parties] = [await count('journal_entries', " AND status IN ('posted','reversed')"), await count('incoming_invoice_documents'), await count('datev_exports'), await count('datev_party_accounts')];
  const chain = await verifyPostgresAuditChain(db, tenantId);
  const text = (value: string | undefined, fallback = '(in den Einstellungen nicht hinterlegt)') => value?.trim() || fallback;
  const legalForms: Record<string, string> = { sole_proprietor: 'Einzelunternehmen', ek: 'eingetragener Kaufmann (e. K.)', gbr: 'GbR', gmbh: 'GmbH', ug: 'UG (haftungsbeschränkt)' };
  const profile = s.businessReportingProfile ?? {};
  const address = [s.company?.street, [s.company?.zip, s.company?.city].filter(Boolean).join(' ')].filter((part) => part?.trim()).join(', ');
  const chart = policy?.active_chart ?? 'SKR03';
  const vat = policy?.vat_method === 'ist' ? 'Ist-Versteuerung (vereinnahmte Entgelte)' : 'Soll-Versteuerung (vereinbarte Entgelte)';
  const periods = closed.length ? `${closed.length} (${closed[0]!.period} bis ${closed.at(-1)!.period})` : 'keine';

  return `# Verfahrensdokumentation (Entwurf)

Stand: ${today}. Dieser Entwurf wurde von billme Pro aus den Einstellungen und dem Buchungsbestand erzeugt. Er folgt der Gliederung der GoBD (Rz. 151 ff.) und des AWV-Musters. Das Unternehmen prüft ihn, ergänzt Abschnitt 5 und zeichnet ihn ab. Jede spätere Änderung des Verfahrens braucht eine neue, datierte Fassung; ältere Fassungen sind aufzubewahren.

## 1. Allgemeine Beschreibung

- Unternehmen: ${text(s.company?.name)}${address ? `, ${address}` : ''}
- Inhaber oder Geschäftsführung: ${text(s.company?.owner)}
- Rechtsform: ${legalForms[profile.legalForm ?? ''] ?? '(nicht hinterlegt)'}
- Gewinnermittlung: ${profile.profitDetermination === 'eur' ? 'Einnahmen-Überschuss-Rechnung (§ 4 Abs. 3 EStG)' : 'doppelte Buchführung mit Bilanz (§§ 238 ff. HGB)'}
- Wirtschaftsjahr beginnt am: ${text(profile.fiscalYearStart, '01-01')} (MM-TT)
- Steuernummer: ${text(s.finance?.taxId)}; USt-IdNr.: ${text(s.finance?.vatId)}
- Umsatzsteuer: ${s.legal?.smallBusinessRule ? 'Kleinunternehmer (§ 19 UStG)' : vat}
- Eingesetzte Software: billme Pro für Rechnungsstellung, Belegerfassung, Bankabgleich, Finanzbuchhaltung und DATEV-Übergabe.

## 2. Anwenderdokumentation

### 2.1 Ausgangsrechnungen
- Rechnungen entstehen als Entwurf und erhalten ihre Nummer erst beim Stellen. Nummernkreis Rechnungen: „${text(s.numbers?.invoicePrefix, '')}“, Angebote: „${text(s.numbers?.offerPrefix, '')}“, Kunden: „${text(s.numbers?.customerPrefix, '')}“. Freigegebene Nummern werden zuerst wieder vergeben, damit keine Lücken entstehen.
- Eine gestellte Rechnung wird nicht mehr geändert; Korrekturen laufen über Storno oder Gutschrift mit Verweis auf das Original.
- Beim Stellen bucht billme die Forderung und den Erlös${s.legal?.smallBusinessRule ? '' : ' samt Umsatzsteuer'} und legt einen offenen Posten an.

### 2.2 Eingangsrechnungen und Belege
- Eingangsrechnungen werden mit Lieferant, Positionen, Steuerfall und Konto erfasst und dann gebucht. Die Belegdatei wird unverändert in der Datenbank abgelegt, zusammen mit ihrem SHA-256-Hash; eine Datei mit gleichem Hash wird abgewiesen. Archivierte Belegdateien: ${receipts}.
- Nicht abziehbare Vorsteuer (§ 15 Abs. 1a UStG) wird je Position gekennzeichnet und brutto auf das Aufwandskonto gebucht.

### 2.3 Bank und Zahlungen
- Kontoauszüge werden als CSV importiert; die Originaldatei wird mit dem Import archiviert. Doppelte Zeilen bleiben sichtbar, statt verworfen zu werden.
- Zahlungen werden über die offenen Posten zugeordnet und gebucht; Storno, Erstattung und Rücklastschrift sind eigene Buchungen.

### 2.4 Hauptbuch
- Kontenrahmen: ${chart}. Umsatzsteuer: ${vat}.
- Jede Buchung ist ausgeglichen (Soll = Haben, von der Datenbank erzwungen) und behält ihre Belegreferenz. Gebuchte Sätze werden nicht geändert; Korrekturen sind Stornobuchungen.
- Gebuchte Buchungssätze bisher: ${entries}.

### 2.5 Festschreibung und Übergabe
- Abgeschlossene Monate werden festgeschrieben; danach sind dort keine Buchungen und Änderungen mehr möglich. Festgeschriebene Monate: ${periods}.
- Übergabe an die Steuerberatung als DATEV-Buchungsstapel (EXTF 700) mit Personenkonten und eigenem Stammdaten-Stapel. Jeder Export wird mit Inhalt und Hash unveränderlich gespeichert. DATEV-Exporte bisher: ${datevExports}; vergebene Personenkonten: ${parties}.

## 3. Technische Systemdokumentation

- Datenhaltung in einer PostgreSQL-kompatiblen Datenbank (lokal PGlite, auf dem Server PostgreSQL), getrennt je Mandant.
- Jede Änderung an Belegen, Stammdaten und Buchungen schreibt einen Eintrag ins Änderungsprotokoll mit Zeitpunkt, Benutzer, Begründung und Vorher-/Nachher-Stand. Die Einträge sind über Hashes verkettet. Prüfkette: ${chain.ok ? 'intakt' : `fehlerhaft (${chain.errors.length} Fehler)`} (${chain.count} Einträge).
- Datenträgerüberlassung (Z3): Das Prüferpaket enthält Journal, Kontenplan, Stammdaten, Belege, offene Posten, Anlagen und Zuordnungen als JSONL und als CSV mit GDPdU-Beschreibung (index.xml), dazu Änderungsprotokoll und Prüfergebnis der Kette.

## 4. Betriebsdokumentation

- Datensicherung: Die Datenbank wird als Archiv gesichert und lässt sich vollständig wiederherstellen. Turnus, Speicherort und Aufbewahrung der Sicherungen legt das Unternehmen in Abschnitt 5 fest.
- Aufbewahrung: Buchungen, Belege und Protokoll bleiben in der Datenbank; billme löscht nichts davon. Fristen nach § 147 AO (8 bzw. 10 Jahre) sind einzuhalten.

## 5. Vom Unternehmen zu ergänzen

- Zuständigkeiten: wer erfasst, wer prüft und gibt frei, wer bucht, wer schreibt fest.
- Internes Kontrollsystem: Vier-Augen-Prinzip, Abstimmungen (Bank, offene Posten, Kasse), Zugriffsrechte.
- Belegeingang: wie Papier- und elektronische Belege ankommen, ob und wie gescannt wird (ersetzendes Scannen) und was mit dem Papier geschieht.
- Datensicherung: Turnus, Speicherort, Wiederherstellungstest.
- Weitere eingesetzte Systeme (Kasse, Onlineshop, Zahlungsdienste) und ihre Schnittstellen zu billme.
- Datum, Name und Unterschrift der verantwortlichen Person.
`;
};
