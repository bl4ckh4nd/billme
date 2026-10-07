# Browser-Lebenszyklen

Start im Repository-Root: `pnpm test:e2e:lifecycle`.

Die Tests starten eine lokale Vite-Testseite und zwei echte gehostete APIs
(Fastify auf PGlite hinter dem Postgres-Wire, `servers.mts`, Ports 4191/4192) mit je
einem Lite- und Pro-Inhaber. Sie prüfen verzögerte Anmeldung, Serverwechsel, Reload,
Abmeldung und ein falsches Passwort für Lite/Pro, anschließend die echten Renderer
mit zwei aufeinanderfolgenden Sessions. Antworten kommen nur vom echten Server; der
erste Test hält die Anmeldeanfrage an Server A lediglich an, bevor er sie weiterleitet.

Screenshots liegen unter `<OS-Temp>/billme-lifecycle-artifacts`, das Ergebnis unter
`<OS-Temp>/billme-lifecycle-results.json`. Tracing ist ausgeschaltet, weil die lokale
Trace-Ausgabe beim Abschluss hängen blieb; Screenshots und JSON bleiben aktiv.
