import fs from 'fs';
import path from 'path';
import type { PdfStore } from './types';

export const createNodeFsPdfStore = (storageDir: string): PdfStore => {
  fs.mkdirSync(storageDir, { recursive: true });
  return {
    putPdf: async (pdfKey, bytes) => {
      fs.writeFileSync(path.join(storageDir, pdfKey), bytes);
    },
    getPdf: async (pdfKey) => {
      const fullPath = path.join(storageDir, pdfKey);
      if (!fs.existsSync(fullPath)) return null;
      return fs.readFileSync(fullPath);
    },
  };
};

