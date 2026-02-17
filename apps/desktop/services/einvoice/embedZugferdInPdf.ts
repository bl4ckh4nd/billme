type EmbedParams = {
  pdfBytes: Uint8Array;
  xml: string;
  invoiceNumber: string;
};

export const embedZugferdInPdf = async ({
  pdfBytes,
  xml,
  invoiceNumber,
}: EmbedParams): Promise<Uint8Array> => {
  const payload = [
    '\n% BILLME_ZUGFERD_PAYLOAD_BEGIN',
    `% invoice=${invoiceNumber}`,
    '% filename=zugferd-invoice.xml',
    xml,
    '% BILLME_ZUGFERD_PAYLOAD_END',
    '',
  ].join('\n');
  const markerBytes = new TextEncoder().encode(payload);
  const out = new Uint8Array(pdfBytes.length + markerBytes.length);
  out.set(pdfBytes, 0);
  out.set(markerBytes, pdfBytes.length);
  return out;
};
