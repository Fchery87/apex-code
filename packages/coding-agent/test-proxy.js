const http = require('http');
const net = require('net');
const server = http.createServer();
server.on("connect", (req, socket, head) => {
    console.log("CONNECT EVENT", req.url);
    socket.destroy();
});
server.listen(9999, () => {
    const c = net.connect(9999, '127.0.0.1', () => {
        c.write('CONNECT 127.0.0.1:1234 HTTP/1.1\r\nHost: 127.0.0.1:1234\r\n\r\n');
    });
    c.on('error', (e) => console.log("CLIENT ERROR", e));
    c.on('close', () => {
        console.log("CLIENT CLOSED");
        server.close();
    });
});
