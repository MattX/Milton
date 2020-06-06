import React from "react";
import {Spinner} from "./Spinner";

import './Reader.css'

export enum ReaderState {
    NONE,
    LOADING,
    LOADED,
}

export interface ReaderProps {
    articleTitle: string | undefined,
    articleUrl: string | undefined,
    articleHtml: string | undefined,
    readerState: ReaderState,
    removeArticle: (() => void) | undefined,
}

export const Reader = (props: ReaderProps) => {
    let articleHtml;
    if (props.articleHtml === undefined) {
        articleHtml = undefined;
    } else {
        articleHtml = {__html: props.articleHtml}
    }
    const removeButton = props.removeArticle ?
        <><button className="btn btn-outline-danger btn-spaced" onClick={props.removeArticle}>Delete</button></> : <></>;
    switch (props.readerState) {
        case ReaderState.NONE: return <React.Fragment/>
        case ReaderState.LOADING: return <Spinner/>
        case ReaderState.LOADED: return <>
            <h2>{props.articleTitle}
                    <a href={props.articleUrl!!} className="btn btn-outline-primary btn-spaced">Read original</a>
                    {removeButton}
            </h2>
            <div className="reader" dangerouslySetInnerHTML={articleHtml} />
        </>
    }
};
