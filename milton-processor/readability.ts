import jsdomLib = require('jsdom');
import domPurify = require('dompurify');
import readability = require('@mozilla/readability');


const JSDOM = jsdomLib.JSDOM;

export interface ParsedOutput {
  title: string;
  siteName: string;
  byline: string;
  excerpt: string;
  length: number;
  textContent: string;
  content: string;
}

export function parse(htmlString: string, baseUrl?: string): ParsedOutput {
  console.debug(`Starting parse: ${Date.now()}`);
  const dom = new JSDOM(htmlString).window;
  console.debug(`Created DOM: ${Date.now()}`);

  const window = domPurify(dom)
  if (baseUrl) {
    window.addHook('afterSanitizeAttributes', (node) => findAndConvertUrls(baseUrl, node));
  }
  window.sanitize(dom.document, {WHOLE_DOCUMENT: true, IN_PLACE: true});
  console.debug(`Sanitized: ${Date.now()}`);

  const result = new readability.Readability(dom.document).parse();
  console.debug(`Readabilized: ${Date.now()}`);

  return result;
}

function findAndConvertUrls(baseUrl: string, node: Element) {
  const linkAttributes = ['href', 'src'];

  linkAttributes.forEach((attr) => {
    if (node.hasAttribute(attr)) {
      const url = toAbsoluteUrl(baseUrl, node.getAttribute(attr));
      node.setAttribute(attr, url);
    }
  });
}

function toAbsoluteUrl(baseUrl: string, url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  try {
    return new URL(url, baseUrl).href;
  } catch (ex) {
    // Something went wrong, just return original
  }
  return url;
}
