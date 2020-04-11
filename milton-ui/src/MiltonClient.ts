import {AxiosResponse} from "axios";

const axios = require('axios').default;

export interface Post {
    title: string,
    url: string,
    site: string,
    storageId: string,
}

export function listPosts(): Promise<Post[]>  {
    return axios.get('http://localhost:8081/list')
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
    return axios.get('http://localhost:8081/content?id=' + storageId)
        .then((response: AxiosResponse) => response.data)
}
