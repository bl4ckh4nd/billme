import React from 'react';
import QRCode from 'qrcode';

type PairingCode = { code: string; expiresAt: string; pairingUri: string };

export const MobilePairingControl: React.FC<{
  apiUrl: string;
  token: string;
  product: 'lite' | 'pro';
}> = ({ apiUrl, token, product }) => {
  const [open, setOpen] = React.useState(false);
  const [pairing, setPairing] = React.useState<PairingCode | null>(null);
  const [qr, setQr] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const createCode = async () => {
    setOpen(true);
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/${product}/auth/pairing-codes`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => null) as PairingCode | { message?: string } | null;
      if (!response.ok || !payload || !('pairingUri' in payload)) {
        throw new Error(payload && 'message' in payload ? payload.message : `Pairing failed with ${response.status}`);
      }
      setPairing(payload);
      setQr(await QRCode.toDataURL(payload.pairingUri, { width: 320, margin: 2, color: { dark: '#141413', light: '#FDFDFD' } }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  return <>
    <button
      type="button"
      className="fixed bottom-5 left-5 z-[80] min-h-11 rounded-full bg-dark-base px-5 text-sm font-semibold text-white shadow-xl transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      onClick={() => void createCode()}
    >
      Pair mobile app
    </button>
    {open ? <div className="fixed inset-0 z-[90] grid place-items-center bg-dark-base/30 p-5" role="dialog" aria-modal="true" aria-labelledby="mobile-pairing-title">
      <div className="w-full max-w-md rounded-3xl border border-border bg-surface p-6 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">One-time code</p>
        <h2 id="mobile-pairing-title" className="mt-2 text-2xl font-semibold text-foreground">Pair Billme Mobile</h2>
        <p className="mt-2 text-sm text-muted">Scan this code in the mobile app. It expires after five minutes and can be used once.</p>
        <div className="mt-5 grid min-h-72 place-items-center rounded-2xl bg-canvas p-4">
          {loading ? <p className="text-sm text-muted">Creating secure code…</p> : null}
          {qr ? <img src={qr} className="size-64 rounded-xl" alt="Billme Mobile pairing QR code" /> : null}
          {error ? <p className="text-sm text-error" role="alert">{error}</p> : null}
        </div>
        {pairing ? <p className="mt-3 text-center font-mono text-lg tracking-[0.24em] text-foreground">{pairing.code}</p> : null}
        <div className="mt-5 flex gap-3">
          <button type="button" className="min-h-11 flex-1 rounded-xl border border-border bg-surface text-sm font-semibold text-foreground active:scale-[0.98]" onClick={() => setOpen(false)}>Close</button>
          <button type="button" className="min-h-11 flex-1 rounded-xl bg-dark-base text-sm font-semibold text-white active:scale-[0.98]" onClick={() => void createCode()}>New code</button>
        </div>
      </div>
    </div> : null}
  </>;
};
