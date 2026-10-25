import React, { useRef, useState } from 'react';
import { FileUp, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import {
  Badge, Button, IconButton, Modal, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import type { Article, Client } from '@billme/desktop-core/types';
import { mapArticleCsv, mapClientCsv, readMasterdataCsv, type CsvImportRow } from '@billme/desktop-services/masterdataCsv';
import { ipc } from '../../runtime-api';

type Props =
  | { kind: 'clients'; existing: Client[]; onClose: () => void }
  | { kind: 'articles'; existing: Article[]; onClose: () => void };

const PREVIEW_ROWS = 20;

const COPY = {
  clients: { title: 'Kunden importieren (CSV)', columns: 'Firma, Kundennummer, Ansprechpartner, E-Mail, Telefon, Straße, PLZ, Ort, Land, USt-IdNr' },
  articles: { title: 'Leistungen importieren (CSV)', columns: 'Artikelnummer, Bezeichnung, Beschreibung, Preis, Einheit, USt, Kategorie' },
} as const;

/**
 * Reads a CSV file chosen in the renderer, previews the mapped rows and saves the
 * valid ones through the regular upsert routes.
 */
export const CsvImportDialog: React.FC<Props> = (props) => {
  const { kind, onClose } = props;
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Array<CsvImportRow<Client | Article>>>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [encodingNote, setEncodingNote] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const titleId = `csv-import-${kind}-title`;

  const readFile = async (file: File) => {
    setSummary(null);
    setReadError(null);
    setEncodingNote(null);
    setFailures([]);
    setFileName(file.name);
    try {
      // Excel saves CSV as Windows-1252 by default; reading that as UTF-8 would store "W�hrungs GmbH".
      const bytes = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder('windows-1252').decode(bytes);
        setEncodingNote('Die Datei ist nicht UTF-8 kodiert und wurde als Windows-1252 (Excel-Standard) gelesen. Bitte prüfe die Umlaute in der Vorschau.');
      }
      const table = readMasterdataCsv(text);
      if (table.rows.length === 0) throw new Error('Die Datei enthält keine Datenzeilen.');
      setRows(props.kind === 'clients'
        ? mapClientCsv(table, props.existing, uuidv4)
        : mapArticleCsv(table, props.existing, uuidv4));
    } catch (error) {
      setRows([]);
      setReadError(error instanceof Error ? error.message : String(error));
    }
  };

  const ready = rows.filter((row) => row.status === 'ok');
  const duplicates = rows.filter((row) => row.status === 'duplicate').length;
  const invalid = rows.filter((row) => row.status === 'error').length;

  const runImport = async () => {
    setImporting(true);
    let imported = 0;
    let failed = 0;
    const reasons: string[] = [];
    // ponytail: one upsert per row, not one transaction; a bulk route is needed once imports exceed ~1000 rows.
    for (const row of ready) {
      try {
        if (kind === 'clients') await ipc.clients.upsert({ client: row.record as Client, reason: `CSV-Import ${fileName}` });
        else await ipc.articles.upsert({ article: row.record as Article });
        imported += 1;
      } catch (error) {
        failed += 1;
        reasons.push(`Zeile ${row.rowIndex} (${row.label}): ${(error instanceof Error ? error.message : String(error)).replace(/^(?:Error:\s*)+/, '')}`);
      }
    }
    setFailures(reasons);
    await queryClient.invalidateQueries({ queryKey: [kind] });
    setRows([]);
    setImporting(false);
    setSummary(`${imported} importiert, ${duplicates} übersprungen, ${invalid + failed} fehlerhaft`);
  };

  return (
    <Modal open onClose={onClose} titleId={titleId} dismissOnBackdrop={false} ariaBusy={importing} className="max-w-3xl">
      <div className="flex items-start gap-3 px-4.5 pb-2.5 pt-4">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-title text-foreground">{COPY[kind].title}</h2>
          <p className="text-caption text-muted">Spalten (deutsch oder englisch, Trennzeichen ; oder ,): {COPY[kind].columns}</p>
        </div>
        <IconButton size="sm" aria-label="Import schließen" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto px-4.5 pb-4 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            aria-label="CSV-Datei auswählen"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void readFile(file);
            }}
          />
          <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={importing}>
            <FileUp size={16} aria-hidden="true" /> Datei wählen
          </Button>
          <span className="truncate text-control text-muted">{fileName || 'Keine Datei gewählt'}</span>
        </div>

        {readError && <p role="alert" className="text-control text-error">{readError}</p>}
        {encodingNote && <p role="status" className="text-control text-foreground">{encodingNote}</p>}
        {summary && <p role="status" className="text-control font-medium text-foreground">{summary}</p>}
        {failures.length > 0 && (
          <ul aria-label="Nicht importiert" className="list-disc pl-5 text-caption text-error">
            {failures.map((failure) => <li key={failure}>{failure}</li>)}
          </ul>
        )}

        {rows.length > 0 && (
          <>
            <p className="text-control text-foreground tabular-nums">
              {ready.length} bereit · {duplicates} Duplikate · {invalid} fehlerhaft
              {rows.length > PREVIEW_ROWS && <span className="text-muted"> · Vorschau der ersten {PREVIEW_ROWS} von {rows.length} Zeilen</span>}
            </p>
            <Table aria-label="Importvorschau" density="compact">
              <TableHeader>
                <TableRow>
                  <TableHead numeric>Zeile</TableHead>
                  <TableHead>{kind === 'clients' ? 'Firma' : 'Bezeichnung'}</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice(0, PREVIEW_ROWS).map((row) => (
                  <TableRow key={row.rowIndex}>
                    <TableCell numeric className="tabular-nums">{row.rowIndex}</TableCell>
                    <TableCell className="max-w-56 truncate">{row.label}</TableCell>
                    <TableCell>
                      {row.status === 'ok' && <Badge tone="success">Bereit</Badge>}
                      {row.status === 'duplicate' && <Badge tone="neutral">übersprungen (Duplikat)</Badge>}
                      {row.status === 'error' && (
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge tone="error">Fehler</Badge>
                          <span className="text-caption text-error">{row.errors.join(' · ')}</span>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
        <Button variant="secondary" onClick={onClose}>{summary ? 'Schließen' : 'Abbrechen'}</Button>
        {!summary && (
          <Button onClick={() => void runImport()} disabled={ready.length === 0 || importing}>
            {importing ? 'Importiere …' : `${ready.length} importieren`}
          </Button>
        )}
      </div>
    </Modal>
  );
};
