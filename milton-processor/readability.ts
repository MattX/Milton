import jsdomLib = require('jsdom');
import domPurify = require('dompurify');
import Readability = require('readability');

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

export function parse(htmlString: string): ParsedOutput {
  console.log(`Starting parse at ${Date.now()}`);
  const dom = new JSDOM(htmlString).window
  console.log(`created dom ${Date.now()}`);
  domPurify(dom).sanitize(dom.document, {WHOLE_DOCUMENT: true, IN_PLACE: true});
  console.log(`sanitized ${Date.now()}`);
  const result = new Readability(dom.document).parse();
  console.log(`readabilized ${Date.now()}`);
  return result;
}

export function fetchArticle(url: string, callback: (content: string, err: Error) => void) {
  fetcherFor(url).get(url, (resp) => {
    let data = '';

    resp.on('data', (chunk) => {
      data += chunk;
    });

    resp.on('end', () => {
      callback(data, undefined);
    });
  }).on("error", (err) => {
    callback("", err);
  });
};

const fetcherFor = (() => {
  const url = require('url');
  const adapters = {
    'http:': require('http'),
    'https:': require('https'),
  };

  return (inputUrl) => {
    return adapters[url.parse(inputUrl).protocol];
  }
})();
