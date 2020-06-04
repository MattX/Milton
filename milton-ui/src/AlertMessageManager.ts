interface MessageInternal {
    id: number;
    text: string;
}

export interface Message {
    text: string;
    dismiss: () => void;
}

export default class AlertMessageManager {
    messages: MessageInternal[] = [];
    nextId: number = 0;
    setMessages: (messages: Message[]) => void;

    constructor(setMessages: (messages: Message[]) => void) {
        this.setMessages = setMessages;
    }

    dismiss(id: number) {
        this.messages = this.messages.filter((message) => message.id !== id);
        this.updateMessages();
    }

    addMessage(text: string, timeoutMillis: number | null = null) {
        const id = this.nextId;
        this.nextId += 1;
        this.messages.push({text: text, id: id});
        if (timeoutMillis !== null) {
            setTimeout(() => this.dismiss(id), timeoutMillis);
        }
        this.updateMessages();
    }

    toMessage(msgInternal: MessageInternal): Message {
        return {
            text: msgInternal.text,
            dismiss: () => this.dismiss(msgInternal.id),
        }
    }

    updateMessages() {
        this.setMessages(this.messages.map(this.toMessage.bind(this)))
    }
}
