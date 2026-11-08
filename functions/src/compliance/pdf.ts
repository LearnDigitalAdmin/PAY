// HTML -> PDF with headless Chromium (puppeteer-core + @sparticuz/chromium). Loaded lazily; one browser can render many reports.
import type { Browser } from "puppeteer-core";

export interface PdfRenderer { render(html: string, footerText: string, pageLabel: string): Promise<Buffer>; close(): Promise<void> }

const clean = (s: string) => s.replace(/[<>&]/g, "");

export function createPdfRenderer(): PdfRenderer {
  let browser: Browser | null = null;
  const open = async (): Promise<Browser> => {
    if (browser && browser.connected) return browser;
    const [{ default: puppeteer }, { default: chromium }] = await Promise.all([import("puppeteer-core"), import("@sparticuz/chromium")]);
    browser = await puppeteer.launch({ args: [...chromium.args, "--font-render-hinting=none"], executablePath: await chromium.executablePath(), headless: true });
    return browser;
  };
  return {
    async render(html, footerText, pageLabel) {
      const b = await open();
      const page = await b.newPage();
      try {
        await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
        const pdf = await page.pdf({
          format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>",
          footerTemplate: `<div style="width:100%;font-size:8px;color:#64748b;padding:0 14mm;display:flex;justify-content:space-between;font-family:Arial,sans-serif"><span>${clean(footerText)}</span><span>${clean(pageLabel)} <span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
          margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
        });
        return Buffer.from(pdf);
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async close() { if (browser) { await browser.close().catch(() => undefined); browser = null; } },
  };
}

/** One-off render: opens a browser, renders, closes it. */
export async function htmlToPdfOnce(html: string, footerText: string, pageLabel: string): Promise<Buffer> {
  const r = createPdfRenderer();
  try { return await r.render(html, footerText, pageLabel); } finally { await r.close(); }
}
