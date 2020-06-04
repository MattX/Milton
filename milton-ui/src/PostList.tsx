import React from 'react';

import './PostList.css';

import {Post} from "./MiltonClient";
import {Spinner} from "./Spinner";

export interface PostListProps {
    posts: Post[] | undefined,
    selectedUrl: string | undefined,
    selectPost: (post: Post) => any,
    search: (query: String) => any,
    clearSearch: (() => any) | undefined,
}

interface SearchState {
    query: string,
}

const Listing = (props: PostListProps) => (
    <ul className="postListUl">{
        props.posts!!.map((post) => {
            const selected = props.selectedUrl === post.url;
            return <li key={post.url} className="postListItem">
                <button className="postButton" onClick={() => props.selectPost(post)}>
                <span className={selected ? "selectedName" : "unselectedName"}>
                    {post.title}
                </span><br/>
                    {post.site === undefined ? "" : "from " + post.site}
                </button>
            </li>;
        })
    }</ul>
);

export class PostList extends React.Component<PostListProps, SearchState> {
    constructor(props: PostListProps) {
        super(props);
        this.state = {query: ''};
    }

    updateQuery(event: any) {
        this.setState({query: event.target.value});
    }

    render(): React.ReactNode {
        let inner;
        if (this.props.posts === undefined) {
            inner = <Spinner/>;
        } else {
            inner = Listing(this.props);
        }

        let clearSearchBtn;
        if (this.props.clearSearch === undefined) {
            clearSearchBtn = <React.Fragment/>;
        } else {
            clearSearchBtn = <button className="btn btn-outline-danger clear-search" type="button"
                                     onClick={this.props.clearSearch}>
                Clear search results
            </button>;
        }

        return (
            <div className="postList">
                <form onSubmit={(e) => {e.preventDefault(); this.props.search(this.state.query);}}>
                    <div className="input-group">
                        <input type="text" className="form-control" placeholder="Search"
                           value={this.state.query} onChange={this.updateQuery.bind(this)}/>
                        <div className="input-group-append" id="button-addon4">
                            <button className="btn btn-outline-primary" type="submit">Search</button>
                        </div>
                    </div>
                </form>
                {clearSearchBtn}
                {inner}
            </div>
        );
    }
}
