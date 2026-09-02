export async function captureUrl(url: string, outPath: string): Promise<void> {
  let chromium: typeof import("playwright").chromium;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    throw new Error(
      "Playwright is not installed. Run `npx playwright install chromium` to set it up.",
    );
  }

  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    throw new Error(
      "Chromium browser not found. Run `npx playwright install chromium` to install it.",
    );
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}
