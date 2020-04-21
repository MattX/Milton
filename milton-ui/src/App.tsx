import React from 'react';
import './App.css';
import {PostList} from "./PostList";
import {getPostContent, listPosts, Post, search} from "./MiltonClient";
import {Reader, ReaderState} from "./Reader";

interface AppState {
    posts: Post[] | undefined,
    selectedPost: Post | undefined,
    selectedPostText: string | undefined,
    readerState: ReaderState,
    viewingSearch: boolean,
    showingPostList: boolean,
}

class App extends React.Component<{}, AppState> {
    constructor(props: {}) {
        super(props);
        this.state = {
            posts: undefined,
            selectedPost: undefined,
            selectedPostText: undefined,
            readerState: ReaderState.NONE,
            viewingSearch: false,
            showingPostList: true,
        }
    }

    componentDidMount(): void {
        listPosts().then((posts) => this.setState({posts: posts}));
    }

    selectPost(post: Post): void {
        this.setState({ selectedPost: post, readerState: ReaderState.LOADING, showingPostList: false })
        getPostContent(post.storageId).then((content) =>
            this.setState({selectedPostText: content, readerState: ReaderState.LOADED}))
    }

    search(query: String): void {
        this.setState({posts: undefined, viewingSearch: true});
        search(query).then((posts) => this.setState({posts: posts}))
    }

    clearSearch(): void {
        this.setState({posts: undefined, viewingSearch: false});
        listPosts().then((posts) => this.setState({posts: posts}));
    }

    togglePostList(): void {
        this.setState({showingPostList: !this.state.showingPostList});
    }

    render() {
        const clearSearch = this.state.viewingSearch ? this.clearSearch.bind(this) : undefined;
        return (
            <div className="App">
                <header className="header">
                    <button className="btn showPostListBtn" onClick={this.togglePostList.bind(this)}>☰</button>
                    <h3 className="headerName">The Milton Library Assistant</h3>
                </header>
                <div className="mainContent">
                <div className={"postListContainer" + (this.state.showingPostList ? " inScope" : "")}>
                    <PostList posts={this.state.posts}
                              selectedUrl={this.state.selectedPost?.url}
                              selectPost={this.selectPost.bind(this)}
                              search={this.search.bind(this)}
                              clearSearch={clearSearch}/>
                </div>
                <div className="readerContainer">
                    <Reader articleHtml={this.state.selectedPostText}
                            readerState={this.state.readerState}
                            articleUrl={this.state.selectedPost?.url}
                            articleTitle={this.state.selectedPost?.title}/>
                </div>
                </div>
            </div>
        );
    }
}

export default App;
