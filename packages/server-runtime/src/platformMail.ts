/**
 * Mail the platform itself sends (invitations, password reset), independent of
 * any workspace's own SMTP setup. Delivered through useSend; without
 * USESEND_API_KEY and BILLME_MAIL_FROM nothing is sent and callers fall back to
 * showing the link.
 */
export interface PlatformMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Same key, same mail: a retried request does not send twice. */
  readonly idempotencyKey: string;
}

export type PlatformMailer = (mail: PlatformMail) => Promise<{ sent: boolean; error?: string }>;

export const createPlatformMailer = (env: NodeJS.ProcessEnv = process.env): PlatformMailer => {
  const apiKey = env.USESEND_API_KEY?.trim();
  const from = env.BILLME_MAIL_FROM?.trim();
  const baseUrl = (env.USESEND_BASE_URL?.trim() || 'https://usesend.mnemonicc.com').replace(/\/+$/, '');
  return async (mail) => {
    if (!apiKey || !from) return { sent: false, error: 'Platform mail is not configured' };
    try {
      const response = await fetch(`${baseUrl}/api/v1/emails`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': mail.idempotencyKey },
        body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return { sent: false, error: `useSend ${response.status}: ${(await response.text()).slice(0, 200)}` };
      return { sent: true };
    } catch (error) {
      return { sent: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** One short paragraph and a button; mail clients render little more reliably. */
export const renderPlatformMail = (args: { greeting: string; body: string; action: string; url: string; footer: string }): { text: string; html: string } => ({
  text: `${args.greeting}\n\n${args.body}\n\n${args.action}: ${args.url}\n\n${args.footer}\n`,
  html: `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;color:#111;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">
<p>${escapeHtml(args.greeting)}</p>
<p>${escapeHtml(args.body)}</p>
<p><a href="${escapeHtml(args.url)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escapeHtml(args.action)}</a></p>
<p style="font-size:13px;color:#555">Funktioniert der Knopf nicht? Diese Adresse im Browser öffnen:<br>${escapeHtml(args.url)}</p>
<p style="font-size:13px;color:#555">${escapeHtml(args.footer)}</p>
</body></html>`,
});
