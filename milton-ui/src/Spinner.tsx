import React from "react";

export const Spinner = (props: {}) => {
    return (
        <div className="d-flex align-items-center">
            Loading...
            <div className="spinner-border ml-auto" role="status" aria-hidden="true"/>
        </div>
    );
}
