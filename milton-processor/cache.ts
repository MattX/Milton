import gcs = require('@google-cloud/storage');
import crypto = require('crypto');
import base64url = require('base64url');
import { ENVIRONMENT, CONFIG } from './scribe';


const MANUSCRIPT_PATH = 'manuscript.json';
const RAW_CONTENTS_PATH = 'raw_content';

export interface ManuscriptData {
  url: string;
  title: string;
  siteName: string;
  byline: string;
  excerpt: string;
  textContent: string;
  content: string;
  cachedAt: number;
  updatedAt: number;
}

export class Manuscript {
  data: ManuscriptData;

  constructor(data: ManuscriptData) {
    this.data = data;
  }

  updateUpdatedAt() {
    this.data.updatedAt = Date.now();
  }

  static fromJson(jsonData: string): Manuscript {
    const data = JSON.parse(jsonData) as ManuscriptData;
    return new Manuscript(data);
  }

  toJson(): string {
    return JSON.stringify(this.data);
  }
}

function createStorageClient() {
  if (ENVIRONMENT !== 'prod') {
    return new gcs.Storage({keyFilename: CONFIG.access_key});
  } else {
    return new gcs.Storage();
  }
}

function sha256Hash(url: string): string {
  return base64url.default.fromBase64(crypto.createHash('sha256').update(url).digest('base64'));
}

function urlToFolder(url: string): string {
  const folderPath =  `${CONFIG.cache_prefix}/${sha256Hash(url)}`;
  console.debug(`URL ${url} located at: ${folderPath}`);
  return folderPath;
}

function urlToFile(url: string, filename: string): gcs.File {
  const storage = createStorageClient();
  const bucket = storage.bucket('scribe-storage');
  const key = `${urlToFolder(url)}/${filename}`;
  return bucket.file(key);
}

export function saveRawContents(url: string, rawContents: any, contentType?: string) {
  const file = urlToFile(url, RAW_CONTENTS_PATH);
  file.save(rawContents).then(() => {
    if (contentType) {
      file.setMetadata({contentType});
    }
    console.log(`Saved raw contents of URL (${url}) to cache`);
  }).catch((err) => {
    console.error(`Failed to save raw contents of URL (${url}) with error: ${err.message}`);
  });
}

export function fetchRawContents(url: string): Promise<string> {
  const file = urlToFile(url, RAW_CONTENTS_PATH);
  const cachedContents = file.download()
    .then(data => data[0].toString())
    .catch(err => {
      console.warn(`Failed to fetch raw content of URL (${url}) with error: ${err.message}`)
      throw err;
    });
  return cachedContents;
}

export function saveManuscript(url: string, contents: Manuscript) {
  const file = urlToFile(url, MANUSCRIPT_PATH);
  file.save(contents.toJson()).then(() => {
    file.setMetadata({contentType: 'application/json'});
    console.log(`Saved manuscript of URL (${url}) to cache`);
  }).catch((err) => {
    console.error(`Failed to save manuscript of URL (${url}) with error: ${err.message}`);
  });
}

export function fetchManuscript(url: string): Promise<Manuscript> {
  const file = urlToFile(url, MANUSCRIPT_PATH);
  const cachedManuscript = file.download().then((data) => {
    const fileContents = data[0].toString();
    return Manuscript.fromJson(fileContents);
  }).catch((err) => {
    console.warn(`Failed to fetch manuscript of URL (${url}) with error: ${err.message}`)
    throw err;
  });
  return cachedManuscript;
}

export function isCached(url: string): Promise<boolean> {
  const file = urlToFile(url, MANUSCRIPT_PATH);
  const exists = file.exists().then((data) => {
    return data[0];
  }).catch((err) => {
    console.error(`Error checking for cached version of ${url}: ${err.message}`);
    return false;
  });
  return exists;
}
