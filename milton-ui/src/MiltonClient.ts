import {AxiosError, AxiosResponse} from "axios";

// const MILTON_MANAGER_HOST = 'https://milton.terbium.io';
const MILTON_MANAGER_HOST = 'http://localhost:8080';
const axios = require('axios').default;

export interface Post {
    title: string,
    url: string,
    site: string,
    storageId: string,
}

export class MiltonClient {
    credentials: String | null;

    constructor(credentials: string | null = null) {
        this.credentials = credentials;
    }

    listPosts(): Promise<Post[]>  {
        return axios.get(`${MILTON_MANAGER_HOST}/list`)
            .then((posts: AxiosResponse<any[]>) => (
                posts.data.map((object) => ({
                    title: object.title,
                    url: object.url,
                    site: object.site,
                    storageId: object.storageId,
                }))
            ));
    }

    getPostContent(storageId: string): Promise<string> {
        return axios.get(`${MILTON_MANAGER_HOST}/content?id=${storageId}`)
            .then((response: AxiosResponse) => response.data)
    }

    search(query: String): Promise<Post[]> {
        return axios.get(`${MILTON_MANAGER_HOST}/search?q=${query}`)
            .then((posts: AxiosResponse<any[]>) => (
                posts.data.map((object) => ({
                    title: object.title,
                    url: object.url,
                    site: object.site,
                    storageId: object.storageId,
                }))
            ));
    }

    testAuthenticate(): Promise<boolean> {
        if (this.credentials === null) {
            return Promise.resolve(false);
        }
        return axios.get(`${MILTON_MANAGER_HOST}/testAuth`, {
            headers: {
                'Authorization': `Bearer google;${this.credentials}`
            }
        }).then(() => true).catch((e: AxiosError) => {console.log(e); return false;})
    }

    setCredentials(credentials: String | null) {
        this.credentials = credentials;
    }
}

