import React from 'react';
import ReactDOM from 'react-dom';
import './index.css';
import App from './App';
import * as serviceWorker from './serviceWorker';

const lightTheme = require('bootswatch/dist/flatly/bootstrap.css').toString();
const darkTheme = require('bootswatch/dist/darkly/bootstrap.css').toString();

function injectCss(stylesheetText: string) {
    const style = document.createElement("style");
    style.setAttribute("type", "text/css");
    style.appendChild(document.createTextNode(stylesheetText));
    document.getElementsByTagName('head')[0].appendChild(style);
}

if (window.matchMedia("(prefers-color-scheme: dark)")) {
    injectCss(darkTheme);
} else {
    injectCss(lightTheme);
}

ReactDOM.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
  document.getElementById('root')
);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://bit.ly/CRA-PWA
serviceWorker.unregister();
