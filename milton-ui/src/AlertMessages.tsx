import React from 'react';
import {Alert} from "react-bootstrap";
import {Message} from "./AlertMessageManager";

export interface AlertMessagesProps {
    messages: Message[];
}

export function AlertMessages(props: AlertMessagesProps) {
    return <div className="alerts">
        {props.messages.map((msg, i) => <Alert key={i} onClose={msg.dismiss} dismissible>
            {msg.text}
        </Alert>)}
    </div>
}
