import React from 'react';
import './App.css';
import {PostList} from "./PostList";
import {getPostContent, listPosts, Post} from "./MiltonClient";
import {Reader, ReaderState} from "./Reader";

interface AppState {
    posts: Post[] | undefined,
    selectedPost: Post | undefined,
    selectedPostText: string | undefined,
    readerState: ReaderState
}

class App extends React.Component<{}, AppState> {
    constructor(props: {}) {
        super(props);
        this.state = {
            posts: undefined,
            selectedPost: undefined,
            selectedPostText: undefined,
            readerState: ReaderState.NONE
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

    render() {
        return (
            <div className="App container-fluid">
                <div className="row">
                    <div className="col-md-4 postListContainer">
                        <PostList posts={this.state.posts}
                                  selectedUrl={this.state.selectedPost?.url}
                                  selectPost={this.selectPost.bind(this)}/>
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
