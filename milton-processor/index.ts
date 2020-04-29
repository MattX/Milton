import fs = require('fs');
import { app } from "./scribe";

const PORT = Number(process.env.PORT) || 8080;

const server = app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});

module.exports = server;
