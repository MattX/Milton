import {AxiosResponse} from "axios";

const axios = require('axios').default;

export interface Post {
    title: string,
    url: string,
    site: string,
    storageId: string,
}

export function listPosts(): Promise<Post[]>  {
    return axios.get('https://milton.terbium.io/list')
        .then((posts: AxiosResponse<any[]>) => (
            posts.data.map((object) => ({
                title: object.title,
                url: object.url,
                site: object.site,
                storageId: object.storageId,
            }))
        ));
}

export function getPostContent(storageId: string): Promise<string> {
    return axios.get('https://milton.terbium.io/content?id=' + storageId)
        .then((response: AxiosResponse) => response.data)
}

export function search(query: String): Promise<Post[]> {
    return axios.get('https://milton.terbium.io/search?q=' + query)
        .then((posts: AxiosResponse<any[]>) => (
            posts.data.map((object) => ({
                title: object.title,
                url: object.url,
                site: object.site,
                storageId: object.storageId,
            }))
        ));
}
