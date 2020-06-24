import { IncomingHttpHeaders } from 'http';
import * as RestClient from 'typed-rest-client/HttpClient';
import { response } from 'express';

export interface ArticleResponse {
  headers: IncomingHttpHeaders;
  body: string;
  rawData: ArrayBuffer;
}

export class FetcherResponse {
  contentType: string;
  body: string;
  rawData: ArrayBuffer;

  constructor(contentType: string) {
    this.contentType = contentType;
  }

  isTextual(): boolean {
    return this.contentType.startsWith('text/');
  }

  addBody(body: string) {
    this.body = body;
  }

  addRawData(rawData: ArrayBuffer) {
    this.rawData = rawData;
  }
}

export function fetchArticle(url: string): Promise<FetcherResponse> {
  const httpClient = new RestClient.HttpClient('Scribe/1.0');
  return httpClient.get(url).then((res) => {
    const headers: IncomingHttpHeaders = res.message.headers;
    const fetcherResponse = new FetcherResponse(headers["content-type"]);

    if (fetcherResponse.isTextual()) {
      return res.readBody().then((body) => {
        fetcherResponse.addBody(body);
        return fetcherResponse;
      });
    } else {
      res.message.setEncoding('binary');

      return new Promise((resolve, reject) => {
        const chunks = [];
        res.message.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk, 'binary'));
        });
        res.message.on('end', () => {
          const binary = Buffer.concat(chunks);
          fetcherResponse.addRawData(binary);
          resolve(fetcherResponse);
        });
        res.message.on('error', (error) => {
          reject(error);
        });
      });
    }
  });
}
