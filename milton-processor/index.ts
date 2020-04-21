import fs = require('fs');
import { app } from "./scribe";

const PORT = Number(process.env.PORT) || 8080;

const serverSecret = fs.readFileSync('secret', 'utf8').trim();
function authenticated(secret: string): boolean {
  return secret === serverSecret
}

const server = app.listen(PORT, () => {
  console.log(`App listening on port ${PORT}`);
});

module.exports = server;
