import gcs = require('@google-cloud/storage');
import crypto = require('crypto');
import base64url = require('base64url');
import { ENVIRONMENT, CONFIG } from './scribe';


export const MANUSCRIPT_PATH = 'manuscript.json';
export const RAW_CONTENTS_PATH = 'raw_content';
export const PDF_PATH = 'snapshot.pdf'
export const SCREENSHOT_PATH = 'screenshot.png'

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

export function saveRawContents(url: string, path: string, rawContents: any, contentType?: string) {
  const file = urlToFile(url, path);
  file.save(rawContents).then(() => {
    if (contentType) {
      file.setMetadata({contentType});
    }
    console.log(`Saved raw contents of URL (${url}) to cache with content-type (${contentType})`);
  }).catch((err) => {
    console.error(`Failed to save raw contents of URL (${url}) with error: ${err.message}`);
  });
}

export interface CachedRawContents {
  contentType: string;
  data: Buffer;
}

export function fetchRawContents(url: string, path: string): Promise<CachedRawContents> {
  const file = urlToFile(url, path);
  const contentType = file.getMetadata()
    .then(metadata => metadata[0].contentType as string)
    .catch(err => {
      console.warn(`Failed to fetch content type of (${url}) with error: ${err.message}`)
      return 'application/octet-stream'
    });
  const cachedContents = file.download()
    .then(data => data[0])
    .catch(err => {
      console.warn(`Failed to fetch raw content of URL (${url}) with error: ${err.message}`)
      throw err;
    });
  return Promise.all([contentType, cachedContents]).then(valArray => {
    return {contentType: valArray[0], data: valArray[1]}
  })
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
