# Browser- und Workspace-Lebenszyklen

Start im Repository-Root: `pnpm test:e2e:lifecycle`.

Die Tests starten eine lokale Vite-Testseite. Sie prüfen verzögerte Anmeldung,
Serverwechsel, Reload und Abmeldung für Lite/Pro, anschließend die echten
Renderer mit zwei aufeinanderfolgenden Sessions. HTTP-Antworten sind kontrollierte
Testdaten; es werden keine produktiven Datenbanken angesprochen.

Der Workspace-Test verwendet die echten Buchhaltungsansichten mit zwei getrennten
Datensätzen. Eine verzögert fehlschlagende Speicherung, Schließen und Refresh dürfen
die Bearbeitung im anderen Workspace nicht verändern. Erneutes Öffnen bestätigt
den gespeicherten Entwurf.

Screenshots liegen unter `<OS-Temp>/billme-lifecycle-artifacts`, das Ergebnis unter
`<OS-Temp>/billme-lifecycle-results.json`. Tracing ist ausgeschaltet, weil die lokale
Trace-Ausgabe beim Abschluss hängen blieb; Screenshots und JSON bleiben aktiv.
