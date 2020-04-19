import express = require('express');
import fs = require('fs');
import { readability } from "./lib";

const PORT = Number(process.env.PORT) || 8080;
const app = express();

const serverSecret = fs.readFileSync('secret', 'utf8').trim();
function authenticated(secret: string): boolean {
  return secret === serverSecret
}

app.use(express.json({limit: '5mb'}));

app.post("/extract", (req, res) => {
  if (!authenticated(req.body.secret)) {
    res.status(403).send('invalid secret');
    return;
  }

  res.send(readability(req.body.page));
});

const server = app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});

module.exports = server;
