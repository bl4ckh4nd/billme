// Last line of defence for errors no screen caught (window.error, unhandledrejection).
// The user sees one German sentence and can close the box; the stack only shows in development.

const OVERLAY_ID = '__app_debug_overlay';

const messageOf = (error: unknown): string => {
  // A ZodError's message is the issue list as JSON; its issue messages are the readable part.
  const issues = (error as { issues?: Array<{ message?: unknown }> } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return [...new Set(issues.map((issue) => String(issue.message ?? '')).filter(Boolean))].join(' ');
  }
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:Error:\s*)+/, '').trim();
};

const show = (label: string, error: unknown, dev: boolean) => {
  console.error(`[fatal:${label}]`, error);
  let box = document.getElementById(OVERLAY_ID);
  if (!box) {
    box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.setAttribute('role', 'alert');
    Object.assign(box.style, {
      position: 'fixed', bottom: '12px', right: '12px', maxWidth: '480px', maxHeight: '50vh', overflow: 'auto',
      padding: '12px 40px 12px 14px', borderRadius: '12px', background: 'rgba(0,0,0,0.85)', color: 'white',
      font: '13px/1.4 system-ui, sans-serif', whiteSpace: 'pre-wrap', zIndex: '999999',
    });
    document.body.appendChild(box);
  }
  box.replaceChildren();
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Meldung schließen');
  Object.assign(close.style, {
    position: 'absolute', top: '6px', right: '8px', background: 'transparent', border: '0', color: 'white',
    font: '20px/1 system-ui, sans-serif', cursor: 'pointer', padding: '4px',
  });
  close.addEventListener('click', () => box?.remove());
  const text = document.createElement('p');
  text.style.margin = '0';
  const message = messageOf(error);
  text.textContent = message
    ? `Das hat nicht geklappt: ${message}`
    : 'Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut.';
  box.append(close, text);
  if (dev && error instanceof Error && error.stack) {
    const stack = document.createElement('pre');
    Object.assign(stack.style, { margin: '8px 0 0', font: '11px/1.4 ui-monospace, monospace', opacity: '0.8' });
    stack.textContent = `${label}\n${error.stack}`;
    box.append(stack);
  }
};

export const installFatalErrorOverlay = (options: { dev: boolean }) => {
  window.addEventListener('error', (event) => show('window.error', event.error ?? event.message, options.dev));
  window.addEventListener('unhandledrejection', (event) => show('unhandledrejection', event.reason, options.dev));
};
