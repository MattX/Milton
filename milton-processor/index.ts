// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
import express = require('express');
import jsdomLib = require('jsdom');
import domPurify = require('dompurify');
import Readability = require("readability");
import fs = require('fs');

const PORT = Number(process.env.PORT) || 8080;
const app = express();
const JSDOM = jsdomLib.JSDOM;

const secret = fs.readFileSync('secret', 'utf8');

app.use(express.json({limit: '5mb'}));

app.post("/extract", (req, res) => {
  if (req.body.secret !== secret) {
    res.status(403).send('invalid secret');
    return;
  }
  const page = req.body.page;
  const dom = new JSDOM(page).window
  domPurify(dom).sanitize(page,  {WHOLE_DOCUMENT: true, IN_PLACE: true});
  const readable = new Readability(dom.document).parse();
  res.send(readable);
});

const server = app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});

module.exports = server;
