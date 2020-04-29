import express = require('express')
import { ReadableOutput, readability, fetchArticle } from "./lib";

export const app = express();
app.use(express.json({limit: '5mb'}));

app.get("/", (req, res) => {
  res.status(200).send('Article scribe ready!');
});

app.post("/extract", (req, res) => {
  res.send(readability(req.body.page));
});

app.post("/simplify", (req, res) => {
  console.log(`Simplifying URL: ${req.body.page}`)
  fetchArticle(req.body.page, (content, err) => {
    if (err) {
      res.status(422).send(`Unable to fetch page: ${err.message}`);
    } else {
      res.send(readability(content));
    }
  });
});

app.get("/simplify", (req, res) => {
  if (!req.query.page) {
    res.status(200).send(`Please specify the page parameter`)
  } else {
    console.log(`Simplifying URL: ${req.query.page.toString()}`)
    fetchArticle(req.query.page.toString(), (content, err) => {
      if (err) {
        res.status(422).send(`Unable to fetch page: ${err.message}`)
      } else {
        const simplified: ReadableOutput = readability(content);

        const simpleArticleHtml = `
          <html>
            <head>
              <title>Milton Scribe</title>
              <style type="text/css">
                body {
                  margin: 40px auto;
                  max-width: 650px;
                  line-height: 1.6;
                  font-size: 18px;
                  color: #444;
                  background-color: #EEEEEE;
                  padding: 0 10px;
                }
                h1,h2,h3 {
                  line-height:1.2;
                }
                @media (prefers-color-scheme: dark) {
                  body {
                      color: #CCCCCC;
                      background-color: #121212;
                  }
                  a {
                    color: #BB86FC;
                  }
              }
              </style>
            </head>
            <body>
              <div class="reader">
                <h1>${simplified.title}</h1>
                ${simplified.content}
              </div>
            </body>
          </html>`

        res.send(simpleArticleHtml);
      }
    });
  }
});

exports.scribe = app;
