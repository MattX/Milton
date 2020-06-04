import React from 'react';
import {Alert} from "react-bootstrap";
import {Message} from "./AlertMessageManager";

import "./AlertMessages.css";

export interface AlertMessagesProps {
    messages: Message[];
}

export function AlertMessages(props: AlertMessagesProps) {
    return <div className="alerts">
        {props.messages.map((msg, i) =>
            <Alert key={i} onClose={msg.dismiss} variant="primary" dismissible>
                {msg.text}
            </Alert>
        )}
    </div>
}
