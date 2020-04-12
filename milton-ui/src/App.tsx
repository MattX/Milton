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
        }
    }

    componentDidMount(): void {
        listPosts().then((posts) => this.setState({posts: posts}));
    }

    selectPost(post: Post): void {
        this.setState({ selectedPost: post, readerState: ReaderState.LOADING })
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

    render() {
        const clearSearch = this.state.viewingSearch ? this.clearSearch.bind(this) : undefined;
        return (
            <div className="App container-fluid">
                <div className="row">
                    <div className="col-md-4 postListContainer">
                        <PostList posts={this.state.posts}
                                  selectedUrl={this.state.selectedPost?.url}
                                  selectPost={this.selectPost.bind(this)}
                                  search={this.search.bind(this)}
                                  clearSearch={clearSearch}/>
                    </div>
                    <div className="col-md-8 readerContainer">
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
