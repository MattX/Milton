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
}

export const Reader = (props: ReaderProps) => {
    let articleHtml;
    if (props.articleHtml === undefined) {
        articleHtml = undefined;
    } else {
        articleHtml = {__html: props.articleHtml}
    }
    switch (props.readerState) {
        case ReaderState.NONE: return <React.Fragment/>
        case ReaderState.LOADING: return <Spinner/>
        case ReaderState.LOADED: return <React.Fragment>
            <h2>{props.articleTitle} <small><a href={props.articleUrl!!}>(Read original)</a></small></h2>
            <div className="reader" dangerouslySetInnerHTML={articleHtml}></div>
        </React.Fragment>
    }
};
