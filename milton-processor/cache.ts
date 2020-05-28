import gcs = require('@google-cloud/storage');
import crypto = require('crypto');
import { ENVIRONMENT, CONFIG } from './scribe';


export interface Manuscript {
  url: string,
  title: string;
  siteName: string;
  byline: string;
  excerpt: string;
  textContent: string;
  content: string;
}

function createStorageClient() {
  if (ENVIRONMENT !== 'prod') {
    return new gcs.Storage({keyFilename: CONFIG.access_key});
  } else {
    return new gcs.Storage();
  }
}

function sha256Hash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('base64');
}

function urlToKey(url: string): string {
  return `${CONFIG.cache_prefix}/${sha256Hash(url)}.json`
}

function urlToFile(url: string): gcs.File {
  const storage = createStorageClient();
  const bucket = storage.bucket('scribe-storage');
  const key = urlToKey(url);
  return bucket.file(key);
}

export function save(url: string, contents: Manuscript) {
  const file = urlToFile(url);
  file.save(JSON.stringify(contents)).then(() => {
    file.setMetadata({contentType: 'application/json'});
    console.log(`Saved contents of URL (${url}) to cache`);
  }).catch((err) => {
    console.log(`Failed to save contents of URL (${url}) with error: ${err.message}`);
  });
}

export function fetch(url: string): Promise<Manuscript> {
  const file = urlToFile(url);
  const cachedManuscript = file.download().then((data) => {
    const fileContents = data[0].toString();
    return JSON.parse(fileContents) as Manuscript;
  }).catch((err) => {
    console.log(`Failed to fetch contents of URL (${url}) with error: ${err.message}`)
    throw err;
  });
  return cachedManuscript;
}

export function isCached(url: string): Promise<boolean> {
  const file = urlToFile(url);
  const exists = file.exists().then((data) => {
    return data[0];
  }).catch((err) => {
    console.log(`Error checking for cached version of ${url}: ${err.message}`);
    return false;
  });
  return exists;
}
