import jsdomLib = require('jsdom');
import domPurify = require('dompurify');
import Readability = require('readability');

const JSDOM = jsdomLib.JSDOM;

export function readability(htmlString: string): string {
  const dom = new JSDOM(htmlString).window
  domPurify(dom).sanitize(htmlString, {WHOLE_DOCUMENT: true, IN_PLACE: true});
  return new Readability(dom.document).parse();
}

export const fetcherFor = (() => {
  const url = require('url');
  const adapters = {
    'http:': require('http'),
    'https:': require('https'),
  };

  return (inputUrl) => {
    return adapters[url.parse(inputUrl).protocol];
  }
})();