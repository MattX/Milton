import React from 'react';
import './App.css';
import {PostList} from "./PostList";
import {getPostContent, listPosts, Post} from "./MiltonClient";

interface AppState {
    posts: Post[] | null,
    selectedPostUrl: string | null,
    articleText: string | null,
}

class App extends React.Component<{}, AppState> {
    constructor(props: {}) {
        super(props);
        this.state = { posts: null, selectedPostUrl: null, articleText: null }
    }

    componentDidMount(): void {
        listPosts().then((posts) => this.setState({posts: posts}));
    }

    selectPost(url: string, storageId: string): void {
        this.setState({ selectedPostUrl: url })
        getPostContent(storageId).then((content) => this.setState({articleText: content}))
    }

    render() {
        let articleHtml;
        if (this.state.articleText === null) {
            articleHtml = undefined;
        } else {
            articleHtml = {__html: this.state.articleText}
        }
        return (
            <div className="App container-fluid">
                <div className="row">
                    <div className="col-md-4">
                        <PostList posts={this.state.posts}
                            selectedUrl={this.state.selectedPostUrl}
                            selectPost={this.selectPost.bind(this)}/>
                    </div>
                    <div className="col-md-8" dangerouslySetInnerHTML={articleHtml}>
                    </div>
                </div>
            </div>
        );
    }
}

export default App;
