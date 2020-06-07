import gcs = require('@google-cloud/storage');
import crypto = require('crypto');
import base64url = require('base64url');
import { ENVIRONMENT, CONFIG } from './scribe';


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
  tags: string[];
}

export class Manuscript {
  data: ManuscriptData;

  constructor(data: ManuscriptData) {
    this.data = data;
  }

  addTag(tag: string): boolean {
    const isNew = !this.data.tags.includes(tag);
    if (isNew) {
      this.data.tags.push(tag);
      this.updateUpdatedAt();
    }
    return isNew;
  }

  removeTag(tag: string): boolean {
    const exists = this.data.tags.includes(tag);
    if (exists) {
      this.data.tags = this.data.tags.filter((t) => t !== tag);
      this.updateUpdatedAt();
    }
    return exists;
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

function urlToKey(url: string): string {
  return `${CONFIG.cache_prefix}/${sha256Hash(url)}.json`;
}

function urlToFile(url: string): gcs.File {
  const storage = createStorageClient();
  const bucket = storage.bucket('scribe-storage');
  const key = urlToKey(url);
  console.debug(`URL ${url} located at: ${key}`);
  return bucket.file(key);
}

export function save(url: string, contents: Manuscript) {
  const file = urlToFile(url);
  file.save(contents.toJson()).then(() => {
    file.setMetadata({contentType: 'application/json'});
    console.log(`Saved contents of URL (${url}) to cache`);
  }).catch((err) => {
    console.error(`Failed to save contents of URL (${url}) with error: ${err.message}`);
  });
}

export function fetch(url: string): Promise<Manuscript> {
  const file = urlToFile(url);
  const cachedManuscript = file.download().then((data) => {
    const fileContents = data[0].toString();
    return Manuscript.fromJson(fileContents);
  }).catch((err) => {
    console.warn(`Failed to fetch contents of URL (${url}) with error: ${err.message}`)
    throw err;
  });
  return cachedManuscript;
}

export function isCached(url: string): Promise<boolean> {
  const file = urlToFile(url);
  const exists = file.exists().then((data) => {
    return data[0];
  }).catch((err) => {
    console.error(`Error checking for cached version of ${url}: ${err.message}`);
    return false;
  });
  return exists;
}
