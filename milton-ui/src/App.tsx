import React from 'react';
import './App.css';
import {PostList} from "./PostList";
import {Post, MiltonClient} from "./MiltonClient";
import {Reader, ReaderState} from "./Reader";
import {IdentityButton} from "./IdentityButton";
import {GoogleLoginResponse, GoogleLoginResponseOffline} from "react-google-login";
import AlertMessageManager, {Message} from "./AlertMessageManager";
import {AlertMessages} from "./AlertMessages";

interface AppState {
    posts: Post[] | undefined,
    selectedPost: Post | undefined,
    selectedPostText: string | undefined,
    readerState: ReaderState,
    viewingSearch: boolean,
    showingPostList: boolean,
    loggedIn: boolean,
    messages: Message[],
}

class App extends React.Component<{}, AppState> {
    client: MiltonClient;
    alertMessageManager: AlertMessageManager;

    constructor(props: {}) {
        super(props);
        this.state = {
            posts: undefined,
            selectedPost: undefined,
            selectedPostText: undefined,
            readerState: ReaderState.NONE,
            viewingSearch: false,
            showingPostList: true,
            loggedIn: localStorage.getItem("credentials") !== null,
            messages: new Array<Message>(),
        }
        this.client = new MiltonClient(localStorage.getItem("credentials"));
        this.alertMessageManager = new AlertMessageManager(msgs => this.setState({messages: msgs}));
    }

    componentDidMount(): void {
        this.client.listPosts().then((posts) => this.setState({posts: posts}));
    }

    selectPost(post: Post): void {
        this.setState({ selectedPost: post, readerState: ReaderState.LOADING, showingPostList: false })
        this.client.getPostContent(post.storageId).then((content) =>
            this.setState({selectedPostText: content, readerState: ReaderState.LOADED}))
    }

    search(query: String): void {
        this.setState({posts: undefined, viewingSearch: true});
        this.client.search(query).then((posts) => this.setState({posts: posts}))
    }

    clearSearch(): void {
        this.setState({posts: undefined, viewingSearch: false});
        this.client.listPosts().then((posts) => this.setState({posts: posts}));
    }

    togglePostList(): void {
        this.setState({showingPostList: !this.state.showingPostList});
    }

    logIn(response: GoogleLoginResponse | GoogleLoginResponseOffline) {
        console.log(response);
        if ("tokenId" in response) {
            this.setState({loggedIn: true});
            localStorage.setItem("credentials", response.tokenId);
            this.client.setCredentials(response.tokenId);
        } else {
            this.loginFailure("No access token in Google response");
        }
    }

    loginFailure(error: any) {
        this.alertMessageManager.addMessage(`Login error: ${error}`);
    }

    logOut() {
        this.setState({loggedIn: false});
        localStorage.removeItem("credentials");
        this.client.setCredentials(null);
    }

    testAuthenticate() {
        this.client.testAuthenticate().then(result => {
            if (result) {
                this.alertMessageManager.addMessage("Test successful!", 10_000);
            } else {
                this.alertMessageManager.addMessage("Test failed.", 10_000);
            }
        });
    }

    render() {
        const clearSearch = this.state.viewingSearch ? this.clearSearch.bind(this) : undefined;
        return (
            <div className="App">
                <AlertMessages messages={this.state.messages} />
                <header className="header">
                    <button className="btn showPostListBtn" onClick={this.togglePostList.bind(this)}>☰</button>
                    <IdentityButton loggedIn={this.state.loggedIn}
                                    onLoginSuccess={this.logIn.bind(this)}
                                    onLoginFailure={this.loginFailure.bind(this)}
                                    onLogout={this.logOut.bind(this)}
                                    testAuthenticate={this.testAuthenticate.bind(this)} />
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
