'use strict';

var sni = require('sni');
var url = require('url');
var jwt = require('jsonwebtoken');
var packer = require('tunnel-packer');

var Devices = {};
Devices.add = function (store, servername, newDevice) {
  var devices = store[servername] || [];
  devices.push(newDevice);
  store[servername] = devices;
};
Devices.remove = function (store, servername, device) {
  var devices = store[servername] || [];
  var index = devices.indexOf(device);

  if (index < 0) {
    console.warn('attempted to remove non-present device', device.deviceId, 'from', servername);
    return null;
  }
  return devices.splice(index, 1)[0];
};
Devices.list = function (store, servername) {
  if (store[servername] && store[servername].length) {
    return store[servername];
  }
  // There wasn't an exact match so check any of the wildcard domains, sorted longest
  // first so the one with the biggest natural match with be found first.
  var deviceList = [];
  Object.keys(store).filter(function (pattern) {
    return pattern[0] === '*' && store[pattern].length;
  }).sort(function (a, b) {
    return b.length - a.length;
  }).some(function (pattern) {
    var subPiece = pattern.slice(1);
    if (subPiece === servername.slice(-subPiece.length)) {
      console.log('"'+servername+'" matches "'+pattern+'"');
      deviceList = store[pattern];
      return true;
    }
  });

  return deviceList;
};
Devices.exist = function (store, servername) {
  return !!(Devices.list(store, servername).length);
};
Devices.next = function (store, servername) {
  var devices = Devices.list(store, servername);
  var device;

  if (devices._index >= devices.length) {
    devices._index = 0;
  }
  device = devices[devices._index || 0];
  devices._index = (devices._index || 0) + 1;

  return device;
};

module.exports.store = { Devices: Devices };
module.exports.create = function (copts) {
  var deviceLists = {};
  var activityTimeout = copts.activityTimeout || 2*60*1000;
  var pongTimeout = copts.pongTimeout || 10*1000;

  function onWsConnection(ws) {
    var socketId = packer.socketToId(ws.upgradeReq.socket);
    var remotes = {};

    function logName() {
      var result = Object.keys(remotes).map(function (jwtoken) {
        return remotes[jwtoken].deviceId;
      }).join(';');

      return result || socketId;
    }
    function sendTunnelMsg(addr, data, service) {
      ws.send(packer.pack(addr, data, service), {binary: true});
    }

    function getBrowserConn(cid) {
      var browserConn;
      Object.keys(remotes).some(function (jwtoken) {
        if (remotes[jwtoken].clients[cid]) {
          browserConn = remotes[jwtoken].clients[cid];
          return true;
        }
      });

      return browserConn;
    }

    function addToken(jwtoken) {
      if (remotes[jwtoken]) {
        // return { message: "token sent multiple times", code: "E_TOKEN_REPEAT" };
        return null;
      }

      var token;
      try {
        token = jwt.verify(jwtoken, copts.secret);
      } catch (e) {
        token = null;
      }

      if (!token) {
        return { message: "invalid access token", code: "E_INVALID_TOKEN" };
      }

      if (!Array.isArray(token.domains)) {
        if ('string' === typeof token.name) {
          token.domains = [ token.name ];
        }
      }

      if (!Array.isArray(token.domains) || !token.domains.length) {
        return { message: "invalid server name", code: "E_INVALID_NAME" };
      }
      if (token.domains.some(function (name) { return typeof name !== 'string'; })) {
        return { message: "invalid server name", code: "E_INVALID_NAME" };
      }

      // Add the custom properties we need to manage this remote, then add it to all the relevant
      // domains and the list of all this websocket's remotes.
      token.deviceId = (token.device && (token.device.id || token.device.hostname)) || token.domains.join(',');
      token.ws = ws;
      token.clients = {};

      token.pausedConns = [];
      ws._socket.on('drain', function () {
        token.pausedConns.forEach(function (conn) {
          if (!conn.manualPause) {
            conn.resume();
          }
        });
        token.pausedConns.length = 0;
      });

      token.domains.forEach(function (domainname) {
        console.log('domainname', domainname);
        Devices.add(deviceLists, domainname, token);
      });
      remotes[jwtoken] = token;
      console.log("added token '" + token.deviceId + "' to websocket", socketId);
      return null;
    }

    function removeToken(jwtoken) {
      var remote = remotes[jwtoken];
      if (!remote) {
        return { message: 'specified token not present', code: 'E_INVALID_TOKEN'};
      }

      // Prevent any more browser connections being sent to this remote, and any existing
      // connections from trying to send more data across the connection.
      remote.domains.forEach(function (domainname) {
        Devices.remove(deviceLists, domainname, remote);
      });
      remote.ws = null;

      // Close all of the existing browser connections associated with this websocket connection.
      Object.keys(remote.clients).forEach(function (cid) {
        remote.clients[cid].end();
      });
      delete remotes[jwtoken];
      console.log("removed token '" + remote.deviceId + "' from websocket", socketId);
      return null;
    }

    var firstToken;
    var authn = (ws.upgradeReq.headers.authorization||'').split(/\s+/);
    if (authn[0] && 'basic' === authn[0].toLowerCase()) {
      try {
        authn = new Buffer(authn[1], 'base64').toString('ascii').split(':');
        firstToken = authn[1];
      } catch (err) { }
    }
    if (!firstToken) {
      firstToken = url.parse(ws.upgradeReq.url, true).query.access_token;
    }
    if (firstToken) {
      var err = addToken(firstToken);
      if (err) {
        sendTunnelMsg(null, [0, err], 'control');
        ws.close();
        return;
      }
    }

    var commandHandlers = {
      add_token: addToken
    , delete_token: function (token) {
        if (token !== '*') {
          return removeToken(token);
        }
        var err;
        Object.keys(remotes).some(function (jwtoken) {
          err = removeToken(jwtoken);
          return err;
        });
        return err;
      }
    };

    var packerHandlers = {
      oncontrol: function (opts) {
        var cmd, err;
        try {
          cmd = JSON.parse(opts.data.toString());
        } catch (err) {}
        if (!Array.isArray(cmd) || typeof cmd[0] !== 'number') {
          var msg = 'received bad command "' + opts.data.toString() + '"';
          console.warn(msg, 'from websocket', socketId);
          sendTunnelMsg(null, [0, {message: msg, code: 'E_BAD_COMMAND'}], 'control');
          return;
        }

        if (cmd[0] < 0) {
          // We only ever send one command and we send it once, so we just hard coded the ID as 1.
          if (cmd[0] === -1) {
            if (cmd[1]) {
              console.log('received error response to hello from', socketId, cmd[1]);
            }
          }
          else {
            console.warn('received response to unknown command', cmd, 'from', socketId);
          }
          return;
        }

        if (cmd[0] === 0) {
          console.warn('received dis-associated error from', socketId, cmd[1]);
          return;
        }

        if (commandHandlers[cmd[1]]) {
          err = commandHandlers[cmd[1]].apply(null, cmd.slice(2));
        }
        else {
          err = { message: 'unknown command "'+cmd[1]+'"', code: 'E_UNKNOWN_COMMAND' };
        }

        sendTunnelMsg(null, [-cmd[0], err], 'control');
      }

    , onmessage: function (opts) {
        var cid = packer.addrToId(opts);
        console.log("remote '" + logName() + "' has data for '" + cid + "'", opts.data.byteLength);

        var browserConn = getBrowserConn(cid);
        if (!browserConn) {
          sendTunnelMsg(opts, {message: 'no matching connection', code: 'E_NO_CONN'}, 'error');
          return;
        }

        browserConn.write(opts.data);
        // If we have more than 1MB buffered data we need to tell the other side to slow down.
        // Once we've finished sending what we have we can tell the other side to keep going.
        if (browserConn.bufferSize > 1024*1024) {
          sendTunnelMsg(opts, null, 'pause');
          browserConn.once('drain', function () {
            sendTunnelMsg(opts, null, 'resume');
          });
        }
      }

    , onpause: function (opts) {
        var cid = packer.addrToId(opts);
        console.log('[TunnelPause]', cid);
        var browserConn = getBrowserConn(cid);
        if (browserConn) {
          browserConn.manualPause = true;
          browserConn.pause();
        } else {
          sendTunnelMsg(opts, {message: 'no matching connection', code: 'E_NO_CONN'}, 'error');
        }
      }
    , onresume: function (opts) {
        var cid = packer.addrToId(opts);
        console.log('[TunnelResume]', cid);
        var browserConn = getBrowserConn(cid);
        if (browserConn) {
          browserConn.manualPause = false;
          browserConn.resume();
        } else {
          sendTunnelMsg(opts, {message: 'no matching connection', code: 'E_NO_CONN'}, 'error');
        }
      }

    , onend: function (opts) {
        var cid = packer.addrToId(opts);
        console.log('[TunnelEnd]', cid);
        var browserConn = getBrowserConn(cid);
        if (browserConn) {
          browserConn.end();
        }
      }
    , onerror: function (opts) {
        var cid = packer.addrToId(opts);
        console.log('[TunnelError]', cid);
        var browserConn = getBrowserConn(cid);
        if (browserConn) {
          browserConn.destroy();
        }
      }
    };
    var unpacker = packer.create(packerHandlers);

    var lastActivity = Date.now();
    var timeoutId;
    function refreshTimeout() {
      lastActivity = Date.now();
    }
    function checkTimeout() {
      // Determine how long the connection has been "silent", ie no activity.
      var silent = Date.now() - lastActivity;

      // If we have had activity within the last activityTimeout then all we need to do is
      // call this function again at the soonest time when the connection could be timed out.
      if (silent < activityTimeout) {
        timeoutId = setTimeout(checkTimeout, activityTimeout-silent);
      }

      // Otherwise we check to see if the pong has also timed out, and if not we send a ping
      // and call this function again when the pong will have timed out.
      else if (silent < activityTimeout + pongTimeout) {
        console.log('pinging', logName());
        try {
          ws.ping();
        } catch (err) {
          console.warn('failed to ping home cloud', logName());
        }
        timeoutId = setTimeout(checkTimeout, pongTimeout);
      }

      // Last case means the ping we sent before didn't get a response soon enough, so we
      // need to close the websocket connection.
      else {
        console.log('home cloud', logName(), 'connection timed out');
        ws.close(1013, 'connection timeout');
      }
    }
    timeoutId = setTimeout(checkTimeout, activityTimeout);

    // Note that our websocket library automatically handles pong responses on ping requests
    // before it even emits the event.
    ws.on('ping', refreshTimeout);
    ws.on('pong', refreshTimeout);
    ws.on('message', function forwardMessage(chunk) {
      refreshTimeout();
      console.log('message from home cloud to tunneler to browser', chunk.byteLength);
      //console.log(chunk.toString());
      unpacker.fns.addChunk(chunk);
    });

    function hangup() {
      clearTimeout(timeoutId);
      console.log('home cloud', logName(), 'connection closing');
      Object.keys(remotes).forEach(function (jwtoken) {
        removeToken(jwtoken);
      });
      ws.terminate();
    }

    ws.on('close', hangup);
    ws.on('error', hangup);

    // We only ever send one command and we send it once, so we just hard code the ID as 1
    sendTunnelMsg(null, [1, 'hello', [unpacker._version], Object.keys(commandHandlers)], 'control');
  }

  function pipeWs(servername, service, conn, remote) {
    console.log('[pipeWs] servername:', servername, 'service:', service);

    var browserAddr = packer.socketToAddr(conn);
    browserAddr.service = service;
    var cid = packer.addrToId(browserAddr);
    console.log('[pipeWs] browser is', cid, 'home-cloud is', packer.socketToId(remote.ws.upgradeReq.socket));

    var sentEnd = false;
    function sendWs(data, serviceOverride) {
      if (remote.ws) {
        try {
          remote.ws.send(packer.pack(browserAddr, data, serviceOverride), { binary: true });
          // If we can't send data over the websocket as fast as this connection can send it to us
          // (or there are a lot of connections trying to send over the same websocket) then we
          // need to pause the connection for a little. We pause all connections if any are paused
          // to make things more fair so a connection doesn't get stuck waiting for everyone else
          // to finish because it got caught on the boundary.
          if (!serviceOverride) {
            if (remote.pausedConns.length || remote.ws.bufferedAmount > 16*1024*1024) {
              conn.pause();
              remote.pausedConns.push(conn);
            }
          }
        } catch (err) {
          console.warn('[pipeWs] error sending websocket message', err);
        }
      }
    }

    var trueEnd = conn.end;
    conn.end = function () {
      // delete the connection from the clients to make sure nothing more can be written, then
      // call the actual end function to clost the write part of the connection.
      delete remote.clients[cid];
      trueEnd.apply(conn, arguments);

      var timeoutId = setTimeout(function () {
        console.warn('[pipeWs] browser connection', cid, 'still open 1 min after sending `end`');
        conn.destroy();
      }, 60*1000);
      conn.on('close', function () {
        clearTimeout(timeoutId);
      });
    };

    remote.clients[cid] = conn;
    conn.on('data', function (chunk) {
      console.log('[pipeWs] data from browser to tunneler', chunk.byteLength);
      sendWs(chunk);
    });
    conn.on('error', function (err) {
      console.warn('[pipeWs] browser connection error', err);
    });
    conn.on('end', function () {
      if (!sentEnd) {
        sendWs(null, 'end');
        sentEnd = true;
      }

      // Only add timeout to make sure other side is eventually closed if it isn't already closed.
      if (remote.clients[cid]) {
        var timeoutId = setTimeout(function () {
          console.warn('[pipeWs] browser connection', cid, 'still open 1 min after receiving `end`');
          conn.destroy();
        }, 60*1000);
        conn.on('close', function () {
          clearTimeout(timeoutId);
        });
      }
    });
    conn.on('close', function (hadErr) {
      console.log('[pipeWs] browser connection closing');
      delete remote.clients[cid];
      if (!sentEnd) {
        sendWs(null, hadErr ? 'error': 'end');
        sentEnd = true;
      }
    });
  }

  function onTcpConnection(conn) {
    // this works when I put it here, but I don't know if it's tls yet here
    // httpsServer.emit('connection', socket);
    //tls3000.emit('connection', socket);

    //var tlsSocket = new tls.TLSSocket(socket, { secureContext: tls.createSecureContext(tlsOpts) });
    //tlsSocket.on('data', function (chunk) {
    //  console.log('dummy', chunk.byteLength);
    //});

    //return;
    conn.once('data', function (firstChunk) {
      // BUG XXX: this assumes that the packet won't be chunked smaller
      // than the 'hello' or the point of the 'Host' header.
      // This is fairly reasonable, but there are edge cases where
      // it does not hold (such as manual debugging with telnet)
      // and so it should be fixed at some point in the future

      // defer after return (instead of being in many places)
      process.nextTick(function () {
        conn.unshift(firstChunk);
      });

      var service = 'tcp';
      var servername;
      var str;
      var m;

      function tryTls() {
        if (-1 !== copts.servernames.indexOf(servername)) {
          console.log("Lock and load, admin interface time!");
          copts.httpsTunnel(servername, conn);
          return;
        }

        if (!servername) {
          console.log("No SNI was given, so there's nothing we can do here");
          copts.httpsInvalid(servername, conn);
          return;
        }

        var nextDevice = Devices.next(deviceLists, servername);
        if (!nextDevice) {
          console.log("No devices match the given servername");
          copts.httpsInvalid(servername, conn);
          return;
        }

        console.log("pipeWs(servername, service, socket, deviceLists['" + servername + "'])");
        pipeWs(servername, service, conn, nextDevice);
      }

      // https://github.com/mscdex/httpolyglot/issues/3#issuecomment-173680155
      if (22 === firstChunk[0]) {
        // TLS
        service = 'https';
        servername = (sni(firstChunk)||'').toLowerCase();
        console.log("tls hello servername:", servername);
        tryTls();
        return;
      }

      if (firstChunk[0] > 32 && firstChunk[0] < 127) {
        str = firstChunk.toString();
        m = str.match(/(?:^|[\r\n])Host: ([^\r\n]+)[\r\n]*/im);
        servername = (m && m[1].toLowerCase() || '').split(':')[0];
        console.log('servername', servername);
        if (/HTTP\//i.test(str)) {
          service = 'http';
          // TODO disallow http entirely
          // /^\/\.well-known\/acme-challenge\//.test(str)
          if (/well-known/.test(str)) {
            // HTTP
            if (Devices.exist(deviceLists, servername)) {
              pipeWs(servername, service, conn, Devices.next(deviceLists, servername));
              return;
            }
            copts.handleHttp(servername, conn);
          }
          else {
            // redirect to https
            copts.handleInsecureHttp(servername, conn);
          }
          return;
        }
      }

      console.error("Got unexpected connection", str);
      conn.write(JSON.stringify({ error: {
        message: "not sure what you were trying to do there..."
      , code: 'E_INVALID_PROTOCOL' }
      }));
      conn.end();
    });
    conn.on('error', function (err) {
      console.error('[error] tcp socket raw TODO forward and close');
      console.error(err);
    });
  }

  return {
    tcp: onTcpConnection
  , ws: onWsConnection
  , isClientDomain: Devices.exist.bind(null, deviceLists)
  };
};
