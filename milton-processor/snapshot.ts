import chromium from "chrome-aws-lambda";
import puppeteer from "puppeteer-core";

let page: puppeteer.Page;

async function getBrowserPage() {
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: chromium.headless
  });
  return browser.newPage();
}

export async function fetchPDF(url: string): Promise<Buffer> {
  try {
    if (!page) {
      page = await getBrowserPage();
    }

    page.goto(url);
    page.emulateMediaType("print");

    return page.pdf({ printBackground: true });
  } catch (error) {
    throw error;
  }
}

export async function fetchScreenshot(url: string): Promise<Buffer|string> {
  try {
    if (!page) {
      page = await getBrowserPage();
    }

    page.goto(url);
    page.emulateMediaType("screen");

    return page.screenshot();
  } catch (error) {
    throw error;
  }
}
