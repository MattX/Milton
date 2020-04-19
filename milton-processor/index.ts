import express = require('express');
import jsdomLib = require('jsdom');
import domPurify = require('dompurify');
import Readability = require('readability');
import ajax = require("xmlhttprequest");
import fs = require('fs');

const PORT = Number(process.env.PORT) || 8080;
const app = express();
const JSDOM = jsdomLib.JSDOM;

const serverSecret = fs.readFileSync('secret', 'utf8').trim();
function authenticated(secret: string): boolean {
  return secret === serverSecret
}

function decipher(htmlString: string): string {
  const dom = new JSDOM(htmlString).window
  domPurify(dom).sanitize(htmlString, {WHOLE_DOCUMENT: true, IN_PLACE: true});
  return new Readability(dom.document).parse();
}

app.use(express.json({limit: '5mb'}));

app.post("/extract", (req, res) => {
  if (!authenticated(req.body.secret)) {
    res.status(403).send('invalid secret');
    return;
  }

  res.send(decipher(req.body.page));
});

app.post("/percolate", (req, res) => {
  if (!authenticated(req.body.secret)) {
    res.status(403).send('invalid secret');
    return;
  }

  var xhr = new ajax.XMLHttpRequest();
  xhr.open('GET', req.body.page)
  xhr.onload = function() {
    if (xhr.status === 200) {
      res.send(decipher(xhr.responseText));
    } else {
      res.status(422).send(`Unable to fetch page... got code: ${xhr.status}`);
      return;
    }
  }
  xhr.send();
});

const server = app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});

module.exports = server;
