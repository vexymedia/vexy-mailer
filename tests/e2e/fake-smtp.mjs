/**
 * A throwaway SMTP server for the browser end-to-end run, so "Test connection"
 * and live sends have something real to talk to. Accepts one hard-coded
 * credential pair and discards every message.
 */
import { SMTPServer } from "smtp-server";
const server = new SMTPServer({
  authOptional: false, secure: false, disabledCommands: ["STARTTLS"],
  onAuth(auth, _s, cb) {
    if (auth.username === "sender@example.com" && auth.password === "secret") return cb(null, { user: auth.username });
    cb(new Error("Invalid username or password"));
  },
  onData(stream, _s, cb) { stream.on("data", () => {}); stream.on("end", cb); },
});
const PORT = Number(process.env.SMTP_PORT ?? 2525);
server.listen(PORT, "127.0.0.1", () => console.log(`fake smtp listening on ${PORT}`));
