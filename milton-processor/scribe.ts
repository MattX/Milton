import express = require('express')
import * as readability from "./readability";
import * as cache from "./cache";
import * as fetcher from "./fetcher";
import * as snapshot from "./snapshot";

import configFile from './config.json';
export const ENVIRONMENT = process.env.NODE_ENV || 'dev';
export const CONFIG = configFile[ENVIRONMENT];

export const app = express();
app.use(express.json({limit: '5mb'}));

app.get("/", (req, res) => {
  res.status(200).send('Article scribe ready!');
});

app.post("/extract", (req, res) => {
  res.send(readability.parse(req.body.page, req.body.url));
});

app.get("/cached", async (req, res) => {
  res.set('Access-Control-Allow-Origin', CONFIG.cors_client);

  const url = req.query.url.toString();
  const articleCached = await cache.isCached(url);

  res.status(200).send(articleCached);
});

app.get("/fetch", async (req, res) => {
  res.set('Access-Control-Allow-Origin', CONFIG.cors_client);

  const url = req.query.url.toString();
  const format = req.query.format.toString();
  console.log(`Fetching cached raw contents of ${url} for ${format} format`);
  const cachedRawContents = await cache.fetchRawContents(url, format);
  res.writeHead(200, {
    'Content-Type': cachedRawContents.contentType,
    'Content-Length': cachedRawContents.data.length,
  });
  res.end(cachedRawContents.data, 'binary');
});

app.options("/simplify", (req, res) => {
  // Allow CORS requests from CDN
  res.set('Access-Control-Allow-Origin', CONFIG.cors_client);
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', ['Content-Type', 'token']);
  res.set('Access-Control-Max-Age', '3600');
  res.status(204).send('');
});

app.post("/simplify", async (req, res) => {
  const url = req.body.page;
  const refreshCache = (req.body.refresh as boolean);
  const token = req.header('token');
  console.log(`Simplifying URL: ${url}`);
  res.set('Access-Control-Allow-Origin', CONFIG.cors_client);

  let manuscript: cache.Manuscript;
  const articleCached = await cache.isCached(url);

  if (articleCached && !refreshCache) {
    console.log(`Found cached version of ${url}`);
    manuscript = await cache.fetchManuscript(url);
    res.send(manuscript.data);
  } else {
    if (token !== process.env.SCRIBE_AUTH_TOKEN) {
      console.warn(`Unauthenticated fetch for URL: ${url} with token: ${token}`);
      res.status(401).send(`Unauthenticated fetch request`);
      return;
    }
    console.log(`Fetching contents of ${url}`);
    fetcher.fetchArticle(url).then(async (response) => {
      console.log(`Saving contents of ${url}`);

      if (response.isTextual()) {
        // save raw contents as text and perform readability parsing
        cache.saveRawContents(url, cache.RAW_CONTENTS_PATH, response.body, response.contentType);

        const po: readability.ParsedOutput = readability.parse(response.body, url);
        manuscript = new cache.Manuscript({
          url,
          title: po.title,
          siteName: po.siteName,
          byline: po.byline,
          excerpt: po.excerpt,
          textContent: po.textContent,
          content: po.content,
          cachedAt: Date.now(),
          updatedAt: Date.now(),
        });
        cache.saveManuscript(url, manuscript);

        // try saving a snapshot
        console.log(`Caching snapshot version of ${url}`);
        const screenshotData = await snapshot.fetchScreenshot(url);
        cache.saveRawContents(url, cache.SCREENSHOT_PATH, screenshotData, 'image/png');
      } else {
        // this article is not textual, so save the raw data and don't try to parse it with readability
        cache.saveRawContents(url, cache.RAW_CONTENTS_PATH, response.rawData, response.contentType);

        // yes this is a sloppy hack...
        manuscript = new cache.Manuscript({
          url,
          title: 'Manuscript unavailable',
          siteName: 'Sitename unavailable',
          byline: 'Byline unavailable',
          excerpt: 'Excerpt unavailable',
          textContent: 'Content unavailable',
          content: 'Content unavailable',
          cachedAt: Date.now(),
          updatedAt: Date.now(),
        });
        cache.saveManuscript(url, manuscript);
      }

      res.send(manuscript.data);
    }).catch((err) => {
      console.warn(`Failed to fetch ${url} with error: ${err.message}`);
      res.status(422).send(`Unable to fetch page: ${err.message}`);
    });
  }
});

exports.scribe = app;
