import { createRequire } from 'node:module';

const { PDFDocument } = createRequire(new URL('../../../packages/desktop-services/package.json', import.meta.url))('pdf-lib');

export const createPdfFixture = async (title) => {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.addPage().drawText(title);
  return Buffer.from(await document.save());
};
