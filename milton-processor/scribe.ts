import express = require('express')
import { readability, fetcherFor } from "./lib";

const app = express();
app.use(express.json({limit: '5mb'}));

app.get("/", (req, res) => {
  res.status(200).send('Article scribe ready!');
})

app.post("/extract", (req, res) => {
  res.send(readability(req.body.page));
});

app.post("/simplify", (req, res) => {
  fetcherFor(req.body.page).get(req.body.page, (resp) => {
    let data = '';

    resp.on('data', (chunk) => {
      data += chunk;
    });

    resp.on('end', () => {
      res.send(readability(data));
    });
  }).on("error", (err) => {
    res.status(422).send(`Unable to fetch page: ${err.message}`);
  });
});

exports.scribe = app;