import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

type PlausibleFn = (eventName: string, options?: { props?: Record<string, string> }) => void;
type WindowWithPlausible = Window & { plausible?: PlausibleFn };

const downloadUrl =
  import.meta.env.VITE_DOWNLOAD_URL ?? 'https://github.com/bl4ckh4nd/billme/releases/latest';
const analyticsDomain = import.meta.env.VITE_ANALYTICS_DOMAIN;
const analyticsScriptSrc = import.meta.env.VITE_ANALYTICS_SRC ?? 'https://plausible.io/js/script.js';
const githubOwner = import.meta.env.VITE_GITHUB_OWNER ?? 'bl4ckh4nd';
const githubRepo = import.meta.env.VITE_GITHUB_REPO ?? 'billme';
const githubLatestReleaseApi = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;

const landingTitle = 'Billme - Rechnungen und Angebote lokal verwalten';

type ReleaseInfo = {
  version: string | null;
  releaseUrl: string;
};

const benefits = [
  {
    title: 'Lokal arbeiten',
    text: 'Deine Daten bleiben auf deinem System. Für die tägliche Arbeit brauchst du keine Cloud.',
  },
  {
    title: 'Vom Angebot bis zur Zahlung',
    text: 'Erstelle Angebote und Rechnungen, ordne Zahlungen zu und verfolge offene Beträge.',
  },
  {
    title: 'Für deutsche Abläufe',
    text: 'Billme unterstützt deutsche Rechnungsabläufe, einschließlich eines optionalen ZUGFeRD-Exports nach EN 16931.',
  },
];

const features = [
  'Visueller Editor für Angebote und Rechnungen mit Vorlagen',
  'Abo-Rechnungen mit automatischer Terminlogik und manuellem Lauf',
  'Banktransaktions-Matching zur Zahlungszuordnung',
  'Kundenverwaltung mit mehreren Kontakten und Kennzahlen',
  'Audit-Log mit Hash-Kette und CSV-Export',
  'Öffentliches Angebotsportal für Freigaben und PDF-Abrufe',
];

const gobdStatements = [
  'Änderungen an wichtigen Daten werden mit Zeitstempel protokolliert',
  'Verläufe bleiben nachvollziehbar und können nicht einfach verschwinden',
  'Protokolle können als CSV exportiert und abgelegt werden',
  'Bei kritischen Änderungen wird ein Grund abgefragt',
];

const faqs = [
  {
    question: 'Läuft Billme offline?',
    answer:
      'Ja, der Kern ist lokal-first. Das Angebotsportal ist optional und separat.',
  },
  {
    question: 'Ist Billme GoBD-zertifiziert?',
    answer:
      'Billme unterstützt GoBD-orientierte Prozesse technisch. Eine offizielle Zertifizierung durch Finanzbehörden wird nicht behauptet.',
  },
  {
    question: 'Welche Systeme werden unterstützt?',
    answer:
      'Der Desktop-Client wird für Windows, macOS und Linux gebaut.',
  },
  {
    question: 'Wie komme ich an Updates?',
    answer:
      'Neue Versionen erscheinen über GitHub Releases. In der App ist eine Update-Logik vorbereitet.',
  },
];

const legalPageIds = ['impressum', 'datenschutz', 'agb'] as const;
type LegalPageId = (typeof legalPageIds)[number];

const legalPageTitles: Record<LegalPageId, string> = {
  impressum: 'Impressum',
  datenschutz: 'Datenschutzerklärung',
  agb: 'AGB und Nutzungsbedingungen',
};

const readLegalPage = (): LegalPageId | null => {
  const hash = window.location.hash.replace(/^#\/?/, '').toLowerCase();
  return legalPageIds.find((id) => id === hash) ?? null;
};

function trackCta(location: string) {
  const plausible = (window as WindowWithPlausible).plausible;
  plausible?.('download_cta_click', { props: { location } });
}

function loadAnalyticsScript() {
  if (!analyticsDomain) {
    return;
  }

  const id = 'billme-analytics-script';
  if (document.getElementById(id)) {
    return;
  }

  const script = document.createElement('script');
  script.id = id;
  script.defer = true;
  script.src = analyticsScriptSrc;
  script.setAttribute('data-domain', analyticsDomain);
  document.head.appendChild(script);
}

const linkClass =
  'inline-flex min-h-6 items-center text-sm font-semibold text-muted underline decoration-control-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-foreground';

const SiteFooter = () => (
  <footer className="border-t border-border bg-surface">
    <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-muted sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
      <p>© {new Date().getFullYear()} Billme Team</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <a className={linkClass} href="https://github.com/bl4ckh4nd/billme" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <a className={linkClass} href="https://github.com/bl4ckh4nd/billme#license" target="_blank" rel="noreferrer">
          Lizenz
        </a>
        <a className={linkClass} href="https://github.com/bl4ckh4nd/billme#documentation" target="_blank" rel="noreferrer">
          Dokumentation
        </a>
        <a className={linkClass} href="#/impressum">
          Impressum
        </a>
        <a className={linkClass} href="#/datenschutz">
          Datenschutz
        </a>
        <a className={linkClass} href="#/agb">
          AGB
        </a>
      </div>
    </div>
  </footer>
);

const ChevronIcon = () => (
  <svg
    viewBox="0 0 20 20"
    aria-hidden="true"
    focusable="false"
    className="h-5 w-5 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180"
  >
    <path
      d="M5 7.5 10 12.5 15 7.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const LegalSection = ({ heading, children }: { heading: string; children: ReactNode }) => (
  <section className="grid gap-2">
    <h2 className="text-lg font-bold tracking-tight text-foreground">{heading}</h2>
    <div className="grid gap-2 text-sm leading-relaxed text-muted">{children}</div>
  </section>
);

const ImpressumContent = () => (
  <>
    <LegalSection heading="Angaben gemäß § 5 DDG">
      <p>Betreiber der Website und verantwortlich für den Inhalt:</p>
      <address className="not-italic">
        Billme Team
        <br />
        Anschrift wird vor der Veröffentlichung ergänzt
        <br />
        Deutschland
      </address>
    </LegalSection>

    <LegalSection heading="Kontakt">
      <p>E-Mail: Kontaktadresse wird vor der Veröffentlichung ergänzt</p>
    </LegalSection>

    <LegalSection heading="Umsatzsteuer-Identifikationsnummer">
      <p>USt-IdNr. wird vor der Veröffentlichung ergänzt, sofern vorhanden.</p>
    </LegalSection>

    <LegalSection heading="Verantwortlich nach § 18 Abs. 2 MStV">
      <p>Billme Team, Anschrift wie oben.</p>
    </LegalSection>

    <LegalSection heading="Art des Angebots">
      <p>
        Diese Website stellt die Billme Desktop-Anwendung vor und verweist auf die Download-Quellen.
        Über die Website werden keine Verträge geschlossen und keine Nutzerkonten geführt.
      </p>
    </LegalSection>

    <p className="text-sm text-muted">Stand: September 2026</p>
  </>
);

const DatenschutzContent = () => (
  <>

    <LegalSection heading="Verantwortlicher">
      <p>
        Billme Team, Deutschland. Die Kontaktadresse wird vor der Veröffentlichung ergänzt.
      </p>
    </LegalSection>

    <LegalSection heading="Umfang der Verarbeitung">
      <p>
        Diese Website ist eine statische Informationsseite über die Billme Desktop-Anwendung. Es gibt
        keine Registrierung, kein Kontaktformular und keinen Newsletter. Cookies werden nicht zu
        Analyse- oder Marketingzwecken gesetzt.
      </p>
      <p>
        Die Desktop-Anwendung selbst läuft lokal auf deinem Rechner. Die dort erfassten
        Geschäftsdaten verlassen dein System nicht über diese Website.
      </p>
    </LegalSection>

    <LegalSection heading="Webanalyse mit Plausible">
      <p>
        Wenn die Reichweitenmessung aktiviert ist, lädt diese Website Plausible Analytics (Plausible
        Insights OÜ, Estland). Plausible arbeitet ohne Cookies: es setzt keine Cookies, speichert
        keine personenbezogenen Daten und schreibt keine vollständigen IP-Adressen auf. Ausgewertet
        werden aggregierte Angaben wie die aufgerufene Seite, das Herkunftsland, die verweisende
        Website und der Gerätetyp. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes
        Interesse an einer datensparsamen Reichweitenmessung). Die Datenschutzerklärung des Anbieters
        steht unter{' '}
        <a className={linkClass} href="https://plausible.io/privacy" target="_blank" rel="noreferrer">
          plausible.io/privacy
        </a>
        .
      </p>
    </LegalSection>

    <LegalSection heading="Hosting und Server-Logs">
      <p>
        Die Website wird als statische Auslieferung betrieben. Der eingesetzte Hoster verarbeitet die
        technisch notwendigen Zugriffsdaten (unter anderem IP-Adresse, Zeitpunkt und angeforderte
        Datei) in Server-Logs, um die Auslieferung zu sichern. Die Hoster-Angaben werden vor der
        Veröffentlichung ergänzt.
      </p>
    </LegalSection>

    <LegalSection heading="Downloads und externe Links">
      <p>
        Der Download-Button führt zu GitHub Releases, die Links zu Lizenz und Dokumentation zu
        GitHub. Beim Aufruf dieser Seiten gelten die Datenschutzbestimmungen von GitHub. Wir
        erhalten dabei keine personenbezogenen Daten über dich.
      </p>
    </LegalSection>

    <LegalSection heading="Deine Rechte">
      <p>
        Du hast nach der DSGVO das Recht auf Auskunft (Art. 15), Berichtigung (Art. 16), Löschung
        (Art. 17), Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und
        Widerspruch (Art. 21). Außerdem kannst du dich bei einer Datenschutz-Aufsichtsbehörde
        beschweren (Art. 77). Eine automatisierte Entscheidungsfindung einschließlich Profiling
        findet nicht statt.
      </p>
    </LegalSection>

    <p className="text-sm text-muted">Stand: September 2026</p>
  </>
);

const AgbContent = () => (
  <>
    <LegalSection heading="Geltungsbereich">
      <p>
        Diese Nutzungsbedingungen beschreiben die Nutzung der Billme Website und der Billme
        Desktop-Anwendung. Über die Website werden keine Verträge geschlossen und keine
        Nutzerkonten geführt. Für die Desktop-Anwendung gilt zusätzlich die mitgelieferte Lizenz.
      </p>
    </LegalSection>

    <LegalSection heading="Leistungsbeschreibung">
      <p>
        Billme stellt eine lokale Desktop-Anwendung für Angebote, Rechnungen und Zahlungen bereit.
        Die Anwendung läuft lokal auf deinem Rechner. Das optionale Angebotsportal dient nur der
        Freigabe einzelner Dokumente per Link.
      </p>
    </LegalSection>

    <LegalSection heading="Pflichten der Nutzer">
      <p>
        Du nutzt die Anwendung für deine eigenen geschäftlichen Unterlagen und prüfst erstellte
        Dokumente vor dem Versand. Steuerlich relevante Angaben stimmst du mit deiner Buchhaltung
        oder Steuerberatung ab.
      </p>
    </LegalSection>

    <LegalSection heading="Verfügbarkeit und Änderungen">
      <p>
        Neue Versionen erscheinen über GitHub Releases. Einzelne Funktionen können im Rahmen der
        Weiterentwicklung angepasst werden. Die Website kann zeitweise nicht erreichbar sein, etwa
        bei Wartung oder Störungen beim Hoster.
      </p>
    </LegalSection>

    <LegalSection heading="Haftung">
      <p>
        Die Anwendung wird ohne Gewähr für einen bestimmten Geschäftserfolg bereitgestellt. Für
        Vorsatz und grobe Fahrlässigkeit gelten die gesetzlichen Regeln. Im Übrigen ist die Haftung
        auf vorhersehbare Schäden bei Verletzung wesentlicher Vertragspflichten begrenzt.
      </p>
    </LegalSection>

    <LegalSection heading="Schlussbestimmungen">
      <p>
        Es gilt deutsches Recht. Sofern zulässig, ist der Gerichtsstand am Sitz des Betreibers. Die
        Betreiberangaben stehen im Impressum.
      </p>
    </LegalSection>

    <p className="text-sm text-muted">Stand: September 2026</p>
  </>
);

const LegalPage = ({ page }: { page: LegalPageId }) => (
  <div className="text-foreground">
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <a href="#top" className="inline-flex items-center gap-3 font-bold tracking-tight">
          <img src="/billme-logo.svg" alt="Billme Logo" className="h-7 w-auto" />
        </a>
        <a className={linkClass} href="#top">
          Zur Startseite
        </a>
      </div>
    </header>

    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-black tracking-tight text-foreground sm:text-4xl">
        {legalPageTitles[page]}
      </h1>
      <div className="mt-8 grid gap-8">
        {page === 'impressum' ? <ImpressumContent /> : page === 'datenschutz' ? <DatenschutzContent /> : <AgbContent />}
      </div>
    </main>

    <SiteFooter />
  </div>
);

export default function App() {
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo>({
    version: null,
    releaseUrl: downloadUrl,
  });
  const [legalPage, setLegalPage] = useState<LegalPageId | null>(readLegalPage);
  const lastView = useRef<LegalPageId | null>(legalPage);

  const versionBadgeLabel = useMemo(
    () => (releaseInfo.version ? `Aktuelle Version ${releaseInfo.version}` : 'Neueste Version auf GitHub'),
    [releaseInfo.version]
  );

  useEffect(() => {
    loadAnalyticsScript();
  }, []);

  useEffect(() => {
    const syncRoute = () => setLegalPage(readLegalPage());
    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  useEffect(() => {
    document.title = legalPage ? `${legalPageTitles[legalPage]} - Billme` : landingTitle;
    if (lastView.current === legalPage) {
      return;
    }
    lastView.current = legalPage;
    window.scrollTo({ top: 0 });
  }, [legalPage]);

  useEffect(() => {
    const abortController = new AbortController();

    const loadReleaseInfo = async () => {
      try {
        const response = await fetch(githubLatestReleaseApi, {
          signal: abortController.signal,
          headers: {
            Accept: 'application/vnd.github+json',
          },
        });

        if (!response.ok) {
          return;
        }

        const data: { tag_name?: string; html_url?: string } = await response.json();
        setReleaseInfo({
          version: data.tag_name ?? null,
          releaseUrl: data.html_url ?? downloadUrl,
        });
      } catch {
        // Keep default fallback when API is unreachable or rate-limited.
      }
    };

    void loadReleaseInfo();

    return () => abortController.abort();
  }, []);

  if (legalPage) {
    return <LegalPage page={legalPage} />;
  }

  return (
    <div className="text-foreground">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4">
        Zum Inhalt springen
      </a>

      <header className="sticky top-0 z-[var(--z-dropdown)] border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <a href="#top" className="inline-flex items-center gap-3 font-bold tracking-tight">
            <img src="/billme-logo.svg" alt="Billme Logo" className="h-7 w-auto" />
          </a>
          <nav className="hidden items-center gap-6 text-sm font-semibold text-muted md:flex">
            <a href="#features" className="inline-flex min-h-6 items-center transition-colors hover:text-foreground">Features</a>
            <a href="#gobd" className="inline-flex min-h-6 items-center transition-colors hover:text-foreground">GoBD</a>
            <a href="#faq" className="inline-flex min-h-6 items-center transition-colors hover:text-foreground">FAQ</a>
          </nav>
          <a
            href={downloadUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => trackCta('header')}
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-accent px-4 text-sm font-bold text-accent-foreground transition-colors hover:bg-accent-hover"
          >
            Jetzt herunterladen
          </a>
        </div>
      </header>

      <main id="main-content">
        <section id="top" className="mx-auto max-w-6xl px-4 pt-14 pb-12 sm:px-6 lg:px-8 lg:pt-20">
          <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
            <div>
              <p className="mb-4 inline-flex rounded-full border border-dark-border bg-dark-base px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-accent">
                Lokale Desktop-App für Deutschland
              </p>
              <h1 className="max-w-xl text-4xl font-black leading-tight tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                Rechnungen schreiben. Ohne deine Daten in die Cloud zu schicken.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">
                Billme bringt Angebote, Rechnungen und Zahlungen in eine lokale Desktop-App. Für
                Selbstständige und kleine Teams, denen eine Tabellenablage nicht mehr reicht.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-4">
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackCta('hero')}
                  className="lp-button-press inline-flex min-h-11 items-center justify-center rounded-2xl bg-accent px-7 py-4 text-base font-black text-accent-foreground transition-colors hover:bg-accent-hover"
                >
                  Desktop-App herunterladen
                </a>
                <a
                  href="#features"
                  className="lp-button-press inline-flex min-h-11 items-center justify-center rounded-2xl border border-control-border bg-surface px-7 py-4 text-base font-bold text-foreground transition-colors hover:bg-surface-muted"
                >
                  Features ansehen
                </a>
              </div>

              <div className="mt-8 flex flex-wrap gap-2 text-xs font-bold uppercase tracking-wide text-muted">
                <a
                  href={releaseInfo.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-6 items-center rounded-full border border-border bg-surface px-3 py-1.5 transition-colors hover:border-control-border hover:text-foreground"
                >
                  {versionBadgeLabel}
                </a>
                <span className="rounded-full border border-border bg-surface px-3 py-1.5">Windows</span>
                <span className="rounded-full border border-border bg-surface px-3 py-1.5">macOS</span>
                <span className="rounded-full border border-border bg-surface px-3 py-1.5">Linux</span>
              </div>
            </div>

            <figure className="overflow-hidden rounded-2xl bg-dark-base text-white shadow-2xl">
              <div className="border-b border-dark-border px-4 py-3">
                <p className="text-xs font-bold uppercase tracking-wider text-accent">App-Vorschau</p>
              </div>
              <img
                src="/billme-screenshot.png"
                alt="Screenshot der Billme Desktop-Anwendung mit Beispieldaten"
                className="h-auto w-full"
                loading="eager"
                decoding="async"
              />
              <figcaption className="border-t border-dark-border px-4 py-3 text-xs leading-relaxed text-dark-muted">
                Beispieldaten: Die Ansicht zeigt die echte Oberfläche mit erfundenen Kundendaten.
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            {benefits.map((item) => (
              <div key={item.title} className="rounded-xl border border-border bg-surface p-6">
                <h2 className="text-xl font-black tracking-tight">{item.title}</h2>
                <p className="mt-3 text-sm leading-relaxed text-muted">{item.text}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-muted">Was Billme abdeckt</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                Die wichtigsten Schritte an einem Ort
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted">
                Du wandelst Angebote in Rechnungen um, ordnest Zahlungen zu und siehst, welche
                Beträge noch offen sind.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {features.map((feature) => (
                <div
                  key={feature}
                  className="rounded-xl border border-border bg-surface px-4 py-4 text-sm font-semibold text-foreground"
                >
                  {feature}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* RHYTHM 2: this section deliberately drops the left/right split used by
            every other section. The statement runs full width and the four
            statements sit as tiles below it, so the band reads as one block. */}
        <section id="gobd" className="bg-dark-base py-16 text-white">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <p className="text-xs font-bold uppercase tracking-wider text-accent">Dokumentation</p>
            <h2 className="mt-3 max-w-3xl text-3xl font-black tracking-tight sm:text-4xl">
              Änderungen an Dokumenten nachvollziehen
            </h2>
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-dark-muted">
              Billme protokolliert Änderungen an wichtigen Daten mit Zeitstempel. So kannst du
              den Bearbeitungsverlauf deiner Unterlagen prüfen.
            </p>
            <ul className="mt-10 grid gap-4 sm:grid-cols-2">
              {gobdStatements.map((statement) => (
                <li
                  key={statement}
                  className="rounded-xl border border-dark-border bg-dark-1 p-5 text-sm leading-relaxed text-white"
                >
                  {statement}
                </li>
              ))}
            </ul>
            <p className="mt-6 max-w-3xl rounded-xl border border-dark-border bg-dark-2 p-4 text-xs leading-relaxed text-dark-muted">
              Wichtig: Ob ein Betrieb GoBD-konform arbeitet, hängt immer auch von internen
              Abläufen ab. Billme ist dabei ein Werkzeug und keine offizielle Zertifizierung.
            </p>
          </div>
        </section>

        <section id="faq" className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
          <h2 className="text-center text-3xl font-black tracking-tight sm:text-4xl">
            Häufige Fragen
          </h2>
          <div className="mt-8 space-y-3">
            {faqs.map((item) => (
              <details key={item.question} className="group rounded-xl border border-border bg-surface">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-base font-bold text-foreground">
                  {item.question}
                  <ChevronIcon />
                </summary>
                <p className="px-5 pb-4 text-sm leading-relaxed text-muted">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
          <div className="rounded-3xl bg-dark-base p-8 text-white sm:p-12">
            <p className="text-xs font-bold uppercase tracking-wider text-accent">
              Billme einrichten
            </p>
            <h2 className="mt-3 max-w-2xl text-3xl font-black tracking-tight sm:text-4xl">
              Erstelle dein erstes Angebot lokal.
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-dark-muted">
              Installiere Billme, richte eine Vorlage ein und erstelle dein erstes Angebot.
            </p>
            <div className="mt-8">
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => trackCta('final')}
                className="lp-button-press inline-flex min-h-11 items-center justify-center rounded-2xl bg-accent px-7 py-4 text-base font-black text-accent-foreground transition-colors hover:bg-accent-hover"
              >
                Jetzt herunterladen
              </a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
