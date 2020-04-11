import React from 'react';
import Spinner from 'react-bootstrap/Spinner'

import './PostList.css';

import {Post} from "./MiltonClient";

export interface PostListProps {
    posts: Post[] | null,
    selectedUrl: string | null,
    selectPost: (url: string, storageId: string) => any,
}

const Listing = (props: PostListProps) => (
    <ul className="postListUl">{
        props.posts!!.map((post) => (
            <li key={post.url} className="postListItem">
                <button className="postButton" onClick={() => props.selectPost(post.url, post.storageId)}>
                    {props.selectedUrl === post.url ? <b>{post.title}</b> : post.title}
                </button>
            </li>
        ))
    }</ul>
);

export const PostList = (props: PostListProps) => {
    let inner;
    if (props.posts == null) {
        inner = (
            <Spinner animation="border" role="status">
                <span className="sr-only">Loading...</span>
            </Spinner>
        )
    } else {
        inner = Listing(props)
    }

    return (
        <div className="post-list">{inner}</div>
    );
};
