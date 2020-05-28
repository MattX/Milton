import express = require('express')
import * as readability from "./readability";
import * as cache from "./cache";

import configFile from './config.json';
export const ENVIRONMENT = process.env.NODE_ENV || 'dev';
export const CONFIG = configFile[ENVIRONMENT];

export const app = express();
app.use(express.json({limit: '5mb'}));

app.get("/", (req, res) => {
  res.status(200).send('Article scribe ready!');
});

app.post("/extract", (req, res) => {
  res.send(readability.parse(req.body.page));
});

app.options("/simplify", (req, res) => {
  // Allow CORS requests from CDN
  res.set('Access-Control-Allow-Origin', CONFIG.cors_client);
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
  res.status(204).send('');
})

app.post("/simplify", async (req, res) => {
  const url = req.body.page;
  console.log(`Simplifying URL: ${url}`);
  res.set('Access-Control-Allow-Origin', CONFIG.cors_client);

  let manuscript: cache.Manuscript;
  const articleCached = await cache.isCached(url);

  if (articleCached) {
    console.log(`Found cached version of ${url}`);
    manuscript = await cache.fetch(url);
    res.send(manuscript);
  } else {
    readability.fetchArticle(url, (content, err) => {
      console.log(`Fetching contents of ${url}`);
      if (err) {
        res.status(422).send(`Unable to fetch page: ${err.message}`);
      } else {
        console.log(`Saving contents of ${url}`);
        const po: readability.ParsedOutput = readability.parse(content);
        manuscript = {
          url,
          title: po.title,
          siteName: po.siteName,
          byline: po.byline,
          excerpt: po.excerpt,
          textContent: po.textContent,
          content: po.content,
        };
        cache.save(url, manuscript);
        res.send(manuscript);
      }
    });
  }
});

exports.scribe = app;
