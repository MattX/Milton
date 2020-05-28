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
  const dom = new JSDOM(htmlString).window
  domPurify(dom).sanitize(htmlString, {WHOLE_DOCUMENT: true, IN_PLACE: true});
  return new Readability(dom.document).parse();
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
