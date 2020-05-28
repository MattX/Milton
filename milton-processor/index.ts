import fs = require('fs');
import { app, CONFIG } from "./scribe";

const server = app.listen(CONFIG.node_port, () => {
  console.log(`App listening on port ${CONFIG.node_port}`);
});

module.exports = server;
