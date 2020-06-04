import GoogleLogin, {GoogleLoginResponse, GoogleLoginResponseOffline} from "react-google-login";
import React from "react";

export interface IdentityButtonProps {
    loggedIn: boolean;
    onLoginSuccess: (response: GoogleLoginResponse | GoogleLoginResponseOffline) => void;
    onLoginFailure: (error: any) => void,
    onLogout: (_: any) => void,
    testAuthenticate: () => void,
}

export function IdentityButton(props: IdentityButtonProps) {
    let logButton;
    if (props.loggedIn) {
        logButton = <button onClick={props.onLogout} className="btn btn-outline-primary">Log out</button>;
    } else {
        logButton = <GoogleLogin
            clientId="1044906185219-4vkbn44qlm9kte30e1teg8v0fjks11c0.apps.googleusercontent.com"
            buttonText="Login"
            onSuccess={props.onLoginSuccess}
            onFailure={props.onLoginFailure}
            cookiePolicy={'single_host_origin'}
        />;
    }
    return <>
        {logButton}
        <button onClick={props.testAuthenticate} className="btn btn-outline-primary">Test authentication</button>
    </>
}
