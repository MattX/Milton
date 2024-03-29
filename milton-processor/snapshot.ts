import chromium from "chrome-aws-lambda";
import puppeteer from "puppeteer-core";

async function getBrowserPage() {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    // executablePath: "/usr/local/Caskroom/google-chrome/latest/Google Chrome.app/Contents/MacOS/Google Chrome",
    executablePath: await chromium.executablePath,
    headless: chromium.headless
  });
  return browser.newPage();
}

export async function fetchPDF(url: string): Promise<Buffer> {
  try {
    const page = await getBrowserPage();

    await page.goto(url);
    await page.emulateMediaType("screen");

    return page.pdf({ printBackground: true });
  } catch (error) {
    throw error;
  }
}

export async function fetchScreenshot(url: string): Promise<Buffer> {
  try {
    const page = await getBrowserPage();

    await page.goto(url);
    await page.emulateMediaType("print");

    return page.screenshot({type: 'png', fullPage: true, encoding: 'binary'}) as Promise<Buffer>;
  } catch (error) {
    throw error;
  }
}
