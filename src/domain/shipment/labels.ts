import { PDFDocument } from 'pdf-lib';
import { getObject, signedUrl } from '../../infra/storage/s3.js';
import { HttpError } from '../../lib/errors.js';
import type { ShipmentRow } from './types.js';

export async function labelSignedUrl(s: ShipmentRow): Promise<string> {
  if (!s.label_url) throw new HttpError(409, 'label_not_ready', '標籤尚未產生');
  return signedUrl(s.label_url);
}

/** 批次合併多張 PDF 標籤；非 PDF（例如綠界 HTML 標籤）列在 skipped */
export async function mergeLabels(shipments: ShipmentRow[]): Promise<{ pdf: Uint8Array; included: string[]; skipped: { id: string; reason: string }[] }> {
  const out = await PDFDocument.create();
  const included: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const s of shipments) {
    if (!s.label_url) {
      skipped.push({ id: s.id, reason: 'label_not_ready' });
      continue;
    }
    if (!s.label_content_type?.startsWith('application/pdf')) {
      skipped.push({ id: s.id, reason: 'not_pdf' });
      continue;
    }
    const src = await PDFDocument.load(await getObject(s.label_url));
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
    included.push(s.id);
  }
  if (included.length === 0) throw new HttpError(409, 'no_pdf_labels', '沒有可合併的 PDF 標籤', { skipped });
  return { pdf: await out.save(), included, skipped };
}
