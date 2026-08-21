import { useEffect, useMemo, useState } from 'react';
import { Card } from '@billme/ui';

type PlausibleFn = (eventName: string, options?: { props?: Record<string, string> }) => void;
type WindowWithPlausible = Window & { plausible?: PlausibleFn };

const downloadUrl =
  import.meta.env.VITE_DOWNLOAD_URL ?? 'https://github.com/bl4ckh4nd/billme/releases/latest';
const analyticsDomain = import.meta.env.VITE_ANALYTICS_DOMAIN;
const analyticsScriptSrc = import.meta.env.VITE_ANALYTICS_SRC ?? 'https://plausible.io/js/script.js';
const githubOwner = import.meta.env.VITE_GITHUB_OWNER ?? 'bl4ckh4nd';
const githubRepo = import.meta.env.VITE_GITHUB_REPO ?? 'billme';
const githubLatestReleaseApi = `https://api.github.com/repos/${githubOwner}/${githubRepo}/releases/latest`;

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

export default function App() {
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo>({
    version: null,
    releaseUrl: downloadUrl,
  });

  const versionBadgeLabel = useMemo(
    () => (releaseInfo.version ? `Aktuelle Version ${releaseInfo.version}` : 'Neueste Version auf GitHub'),
    [releaseInfo.version]
  );

  useEffect(() => {
    loadAnalyticsScript();
  }, []);

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

  return (
    <div className="lp-shell text-foreground">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-4 focus:left-4">
        Zum Inhalt springen
      </a>
      <div className="lp-noise" aria-hidden="true" />

      <header className="sticky top-0 z-40 border-b border-border/70 bg-white/85 backdrop-blur-lg">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <a href="#top" className="inline-flex items-center gap-3 font-bold tracking-tight">
            <img src="/billme-logo.svg" alt="Billme Logo" className="h-7 w-auto" />
          </a>
          <nav className="hidden items-center gap-6 text-sm font-semibold text-gray-700 md:flex">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#gobd" className="hover:text-foreground transition-colors">GoBD</a>
            <a href="#faq" className="hover:text-foreground transition-colors">FAQ</a>
          </nav>
          <a
            href={downloadUrl}
            target="_blank"
            rel="noreferrer"
            onClick={() => trackCta('header')}
            className="inline-flex items-center justify-center rounded-xl bg-accent px-4 py-2 text-sm font-bold text-accent-foreground transition-all hover:bg-accent-hover"
          >
            Jetzt herunterladen
          </a>
        </div>
      </header>

      <main id="main-content">
        <section id="top" className="relative mx-auto max-w-6xl px-4 pt-14 pb-12 sm:px-6 lg:px-8 lg:pt-20">
          <div className="grid items-center gap-10 lg:grid-cols-[1.1fr_1fr]">
            <div className="lp-enter">
              <p className="mb-4 inline-flex rounded-full border border-dark-border bg-dark-base px-4 py-1.5 text-xs font-bold uppercase tracking-[0.12em] text-accent">
                Lokale Desktop-App für Deutschland
              </p>
              <h1 className="max-w-xl text-4xl font-black leading-tight tracking-tight text-foreground sm:text-5xl lg:text-6xl">
                Rechnungen schreiben. Ohne deine Daten in die Cloud zu schicken.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-gray-700">
                Billme bringt Angebote, Rechnungen und Zahlungen in eine lokale Desktop-App. Für
                Selbstständige und kleine Teams, denen eine Tabellenablage nicht mehr reicht.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-4">
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => trackCta('hero')}
                  className="lp-button-press lp-pulse-glow inline-flex items-center justify-center rounded-2xl bg-accent px-7 py-4 text-base font-black text-accent-foreground shadow-sm transition-all hover:-translate-y-0.5 hover:bg-accent-hover"
                >
                  Desktop-App herunterladen
                </a>
                <a
                  href="#features"
                  className="lp-button-press inline-flex items-center justify-center rounded-2xl border border-border bg-surface px-7 py-4 text-base font-bold text-foreground transition-all hover:border-gray-300 hover:bg-surface-muted"
                >
                  Features ansehen
                </a>
              </div>

              <div className="mt-8 flex flex-wrap gap-2 text-xs font-bold uppercase tracking-wide text-gray-600">
                <a
                  href={releaseInfo.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full border border-border bg-white px-3 py-1.5 transition-colors hover:border-gray-300 hover:text-foreground"
                >
                  {versionBadgeLabel}
                </a>
                <span className="rounded-full border border-border bg-white px-3 py-1.5">Windows</span>
                <span className="rounded-full border border-border bg-white px-3 py-1.5">macOS</span>
                <span className="rounded-full border border-border bg-white px-3 py-1.5">Linux</span>
              </div>
            </div>

            <Card className="lp-enter lp-enter-delay-1 lp-float overflow-hidden border-dark-border bg-dark-base p-0 text-white shadow-2xl shadow-black/20">
              <div className="border-b border-dark-border p-4">
                <p className="text-xs font-bold uppercase tracking-[0.12em] text-accent">App-Vorschau</p>
              </div>
              <img
                src="/billme-screenshot.png"
                alt="Screenshot der Billme Desktop-Anwendung"
                className="h-auto w-full"
                loading="eager"
                decoding="async"
              />
            </Card>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            {benefits.map((item, index) => (
              <Card
                key={item.title}
                className={`lp-enter lp-hover-lift ${index === 1 ? 'lp-enter-delay-1' : index === 2 ? 'lp-enter-delay-2' : ''}`}
              >
                <h2 className="text-xl font-black tracking-tight">{item.title}</h2>
                <p className="mt-3 text-sm leading-relaxed text-gray-700">{item.text}</p>
              </Card>
            ))}
          </div>
        </section>

        <section id="features" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr]">
            <div className="lp-enter">
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-gray-600">Was Billme abdeckt</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                Die wichtigsten Schritte an einem Ort
              </h2>
              <p className="mt-4 text-base leading-relaxed text-gray-700">
                Du wandelst Angebote in Rechnungen um, ordnest Zahlungen zu und siehst, welche
                Beträge noch offen sind.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              {features.map((feature, index) => (
                <div
                  key={feature}
                  className={`lp-enter lp-hover-lift rounded-2xl border border-border bg-white px-4 py-4 text-sm font-semibold text-gray-800 ${index % 2 === 1 ? 'lp-enter-delay-1' : 'lp-enter-delay-2'}`}
                >
                  {feature}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="gobd" className="bg-dark-base py-16 text-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
            <div className="lp-enter">
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-accent">Dokumentation</p>
              <h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">
                Änderungen an Dokumenten nachvollziehen
              </h2>
              <p className="mt-4 text-base leading-relaxed text-gray-300">
                Billme protokolliert Änderungen an wichtigen Daten mit Zeitstempel. So kannst du
                den Bearbeitungsverlauf deiner Unterlagen prüfen.
              </p>
            </div>
            <div className="lp-enter lp-enter-delay-1 rounded-3xl border border-dark-border bg-dark-1 p-6">
              <ul className="space-y-3 text-sm text-gray-200">
                <li>Änderungen an wichtigen Daten werden mit Zeitstempel protokolliert</li>
                <li>Verläufe bleiben nachvollziehbar und können nicht einfach verschwinden</li>
                <li>Protokolle können als CSV exportiert und abgelegt werden</li>
                <li>Bei kritischen Änderungen wird ein Grund abgefragt</li>
              </ul>
              <p className="mt-5 rounded-xl border border-dark-border bg-dark-2 p-3 text-xs leading-relaxed text-gray-300">
                Wichtig: Ob ein Betrieb GoBD-konform arbeitet, hängt immer auch von internen
                Abläufen ab. Billme ist dabei ein Werkzeug und keine offizielle Zertifizierung.
              </p>
            </div>
          </div>
        </section>

        <section id="faq" className="mx-auto max-w-4xl px-4 py-16 sm:px-6 lg:px-8">
          <h2 className="text-center text-3xl font-black tracking-tight sm:text-4xl">
            Häufige Fragen
          </h2>
          <div className="mt-8 space-y-3">
            {faqs.map((item, index) => (
              <details
                key={item.question}
                className={`lp-enter rounded-2xl border border-border bg-white px-5 py-4 ${index > 0 ? 'lp-enter-delay-1' : ''}`}
              >
                <summary className="cursor-pointer list-none text-base font-bold text-foreground">
                  {item.question}
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-gray-700">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6 lg:px-8">
          <Card className="lp-enter relative overflow-hidden border-dark-base bg-dark-base p-8 text-white sm:p-12">
            <div
              aria-hidden="true"
              className="absolute -top-20 -right-12 h-44 w-44 rounded-full bg-accent/40 blur-2xl"
            />
            <p className="relative text-sm font-bold uppercase tracking-[0.14em] text-accent">
              Billme einrichten
            </p>
            <h2 className="relative mt-3 max-w-2xl text-3xl font-black tracking-tight sm:text-4xl">
              Erstelle dein erstes Angebot lokal.
            </h2>
            <p className="relative mt-4 max-w-2xl text-base leading-relaxed text-gray-300">
              Installiere Billme, richte eine Vorlage ein und erstelle dein erstes Angebot.
            </p>
            <div className="relative mt-8">
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => trackCta('final')}
                className="lp-button-press lp-pulse-glow inline-flex items-center justify-center rounded-2xl bg-accent px-7 py-4 text-base font-black text-accent-foreground transition-all hover:-translate-y-0.5 hover:bg-accent-hover"
              >
                Jetzt herunterladen
              </a>
            </div>
          </Card>
        </section>
      </main>

      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-sm text-gray-600 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <p>© {new Date().getFullYear()} Billme Team</p>
          <div className="flex flex-wrap items-center gap-4">
            <a className="hover:text-foreground transition-colors" href="https://github.com/bl4ckh4nd/billme" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a className="hover:text-foreground transition-colors" href="https://github.com/bl4ckh4nd/billme#license" target="_blank" rel="noreferrer">
              Lizenz
            </a>
            <a className="hover:text-foreground transition-colors" href="https://github.com/bl4ckh4nd/billme#documentation" target="_blank" rel="noreferrer">
              Dokumentation
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
