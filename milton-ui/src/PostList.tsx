import React from 'react';

import './PostList.css';

import {Post} from "./MiltonClient";
import {Spinner} from "./Spinner";

export interface PostListProps {
    posts: Post[] | undefined,
    selectedUrl: string | undefined,
    selectPost: (post: Post) => any,
}

const Listing = (props: PostListProps) => (
    [<div></div>,
    <ul className="postListUl">{
        props.posts!!.map((post) => {
            const selected = props.selectedUrl === post.url;
            return <li key={post.url} className="postListItem">
                <button className="postButton" onClick={() => props.selectPost(post)}>
                <span className={selected ? "selectedName" : "unselectedName"}>
                    {post.title} {selected ? " ⮜" : ""}
                </span><br/>
                    {post.site === undefined ? "" : "from " + post.site}
                </button>
            </li>
        })
    }</ul>]
);

export const PostList = (props: PostListProps) => {
    let inner;
    if (props.posts == null) {
        inner = <Spinner/>
    } else {
        inner = Listing(props)
    }

    return (
        <div className="postList">
            <header className="postListHeader"><em>The Milton Library Assistant</em></header>
            {inner}
        </div>
    );
};
