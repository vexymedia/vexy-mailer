import net from "node:net";
import type { AddressInfo } from "node:net";

/**
 * A scriptable IMAP server, just enough of the protocol for imapflow to
 * connect, authenticate and SELECT. Lets the tests exercise real failure
 * shapes - a rejected password, an unopenable INBOX - instead of stubbing the
 * client and assuming what the server would have said.
 */
export interface FakeImap {
  port: number;
  close: () => Promise<void>;
  /** Credentials the server will accept. */
  accept: { user: string; pass: string };
  /** When set, SELECT/EXAMINE is refused even after a successful login. */
  refuseSelect: boolean;
}

export async function startFakeImap(accept = { user: "karolina@vexy.cz", pass: "correct-pass" }): Promise<FakeImap> {
  const state: FakeImap = {
    port: 0,
    accept,
    refuseSelect: false,
    close: async () => {},
  };

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("* OK [CAPABILITY IMAP4rev1] Fake IMAP ready\r\n");
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split("\r\n").filter(Boolean)) {
        const [tag, rawCommand, ...args] = line.split(" ");
        const command = (rawCommand ?? "").toUpperCase();

        if (command === "CAPABILITY") {
          // No AUTH= mechanisms advertised, so imapflow uses plain LOGIN.
          socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
        } else if (command === "ID") {
          socket.write(`* ID NIL\r\n${tag} OK done\r\n`);
        } else if (command === "LOGIN") {
          const user = (args[0] ?? "").replace(/^"|"$/g, "");
          const pass = (args[1] ?? "").replace(/^"|"$/g, "");
          if (user === state.accept.user && pass === state.accept.pass) {
            socket.write(`${tag} OK logged in\r\n`);
          } else {
            socket.write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`);
          }
        } else if (command === "SELECT" || command === "EXAMINE") {
          if (state.refuseSelect) {
            socket.write(`${tag} NO [NONEXISTENT] Mailbox does not exist\r\n`);
          } else {
            socket.write(
              "* 0 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 1] ok\r\n" +
                `${tag} OK [READ-WRITE] selected\r\n`,
            );
          }
        } else if (command === "LOGOUT") {
          socket.write(`* BYE\r\n${tag} OK done\r\n`);
          socket.end();
        } else {
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}
