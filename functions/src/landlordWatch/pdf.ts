// HTML -> PDF with headless Chromium (puppeteer-core + @sparticuz/chromium, the same stack the invoice PDFs use).
// Loaded lazily so the other Cloud Functions in this codebase do not pay for Chromium at cold start.
export async function htmlToPdf(html: string, footerText: string, pageLabel: string): Promise<Buffer> {
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([import("puppeteer-core"), import("@sparticuz/chromium")]);
  const browser = await puppeteer.launch({
    args: [...chromium.args, "--font-render-hinting=none"],
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font-size:8px;color:#64748b;padding:0 14mm;display:flex;justify-content:space-between;font-family:Arial,sans-serif"><span>${footerText.replace(/[<>&]/g, "")}</span><span>${pageLabel.replace(/[<>&]/g, "")} <span class="pageNumber"></span>/<span class="totalPages"></span></span></div>`,
      margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
