import { describe, expect, it } from 'vitest';
import { embedZugferdInPdf } from './embedZugferdInPdf';

describe('embedZugferdInPdf', () => {
  it('embeds XML attachment into PDF bytes', async () => {
    const input = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

    const output = await embedZugferdInPdf({
      pdfBytes: input,
      xml: '<?xml version="1.0" encoding="UTF-8"?><Invoice/>',
      invoiceNumber: 'RE-2026-001',
    });

    const asText = Buffer.from(output).toString('latin1');
    expect(output.length).toBeGreaterThan(input.length);
    expect(asText).toContain('zugferd-invoice.xml');
    expect(asText).toContain('BILLME_ZUGFERD_PAYLOAD_BEGIN');
  });
});
