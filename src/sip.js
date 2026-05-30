/**
 * sip.js — Cliente SIP mínimo via UDP (dgram nativo do Node.js)
 *
 * Implementa apenas o necessário:
 *   - REGISTER no WaVoIP com Digest Auth (MD5)
 *   - INVITE outbound com SDP
 *   - ACK após 200 OK
 *   - Resposta 200 OK ao BYE recebido
 */

const dgram  = require('dgram');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const EventEmitter = require('events');

// ── Helpers ───────────────────────────────────────────────────────────────────

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function digestResponse({ method, uri, realm, nonce, username, password }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2  = md5(`${method}:${uri}`);
  return md5(`${ha1}:${nonce}:${ha2}`);
}

// Mapa de payload types conhecidos — para log legível
const CODEC_NAMES = { 0: 'PCMU/8000', 8: 'PCMA/8000', 9: 'G722/8000(real 16kHz)', 18: 'G729/8000' };

function parseSDP(body = '') {
  let ip = null, port = null, codecs = [];
  for (const line of body.split(/\r?\n/)) {
    const c = line.match(/^c=IN IP4 (.+)/);     if (c) ip = c[1].trim();
    const m = line.match(/^m=audio (\d+)[^\d]+(.+)/);
    if (m) {
      port   = parseInt(m[1]);
      codecs = m[2].trim().split(/\s+/).map(Number);
    }
  }
  // Loga codecs aceitos pelo remoto
  if (codecs.length) {
    const names = codecs.map(pt => CODEC_NAMES[pt] || `PT${pt}`);
    console.log(`[SDP] Codecs aceitos pelo WaVoIP: ${names.join(', ')} — usando PT${codecs[0]}`);
    if (codecs[0] === 9)      console.log('[SDP] ✅ G.722 WIDEBAND CONFIRMADO pelo WaVoIP!');
    else if (codecs[0] === 0) console.log('[SDP] ⚠️  WaVoIP caiu para PCMU (G.722 não aceito ou não oferecido)');
  }
  return { ip, port, codec: codecs[0] ?? 0 };
}

function buildSDP(localIp, rtpPort) {
  const ts = Date.now();
  return [
    'v=0',
    `o=vb ${ts} ${ts} IN IP4 ${localIp}`,
    's=voice-bridge',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    // Oferece G.722 (PT9) como preferência, PCMU (PT0) como fallback
    // Se WaVoIP suportar G.722, o 200 OK virá com PT9 → qualidade HD (16kHz real)
    // Nota SDP: G.722 é listado como /8000 por legado (RFC 3551 §4.5.2) mas opera em 16kHz
    `m=audio ${rtpPort} RTP/AVP 9 0`,
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:0 PCMU/8000',
    'a=sendrecv',
  ].join('\r\n') + '\r\n';
}

// ── Parser SIP mínimo ─────────────────────────────────────────────────────────

function parseSIP(raw) {
  const text = raw.toString();
  const [headPart, ...bodyParts] = text.split('\r\n\r\n');
  const lines = headPart.split('\r\n');
  const firstLine = lines[0];

  const msg = { headers: {}, content: bodyParts.join('\r\n\r\n') };

  const statusMatch = firstLine.match(/^SIP\/2\.0 (\d+) (.+)/);
  if (statusMatch) {
    msg.status = parseInt(statusMatch[1]);
    msg.reason = statusMatch[2];
  }

  const reqMatch = firstLine.match(/^(\w+) (.+) SIP\/2\.0/);
  if (reqMatch) {
    msg.method = reqMatch[1];
    msg.uri    = reqMatch[2];
  }

  for (let i = 1; i < lines.length; i++) {
    const col = lines[i].indexOf(':');
    if (col < 0) continue;
    const key = lines[i].slice(0, col).trim().toLowerCase();
    const val = lines[i].slice(col + 1).trim();
    msg.headers[key] = val;
  }

  return msg;
}

// ── Serializer de requisições SIP ─────────────────────────────────────────────

function buildSIPRequest({ method, requestUri, headers, body = '' }) {
  const lines = [`${method} ${requestUri} SIP/2.0`];
  const h = headers;

  lines.push(`Via: SIP/2.0/UDP ${h.localIp}:5060;branch=${h.branch};rport`);
  lines.push(`From: <sip:${h.username}@${h.host}>;tag=${h.fromTag}`);
  lines.push(`To: ${h.to || `<sip:${h.toUser}@${h.host}>`}${h.toTag ? `;tag=${h.toTag}` : ''}`);
  lines.push(`Call-ID: ${h.callId}`);
  lines.push(`CSeq: ${h.cseq} ${method}`);
  lines.push(`Contact: <sip:${h.username}@${h.localIp}:5060>`);
  lines.push(`Max-Forwards: 70`);
  lines.push(`User-Agent: voice-bridge/1.0`);

  if (h.authorization) lines.push(`Authorization: ${h.authorization}`);
  if (h.expires !== undefined) lines.push(`Expires: ${h.expires}`);
  if (body) {
    lines.push(`Content-Type: application/sdp`);
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  } else {
    lines.push(`Content-Length: 0`);
  }

  lines.push('');
  if (body) lines.push(body);

  return lines.join('\r\n') + '\r\n';
}

// ── Serializer de respostas SIP (para responder BYE, etc.) ───────────────────

function buildSIPResponse({ status, reason, reqHeaders }) {
  // Ecoa os headers essenciais da requisição recebida
  const lines = [
    `SIP/2.0 ${status} ${reason}`,
    `Via: ${reqHeaders['via'] || ''}`,
    `From: ${reqHeaders['from'] || ''}`,
    `To: ${reqHeaders['to'] || ''}`,
    `Call-ID: ${reqHeaders['call-id'] || ''}`,
    `CSeq: ${reqHeaders['cseq'] || ''}`,
    `Content-Length: 0`,
    '',
  ];
  return lines.join('\r\n') + '\r\n';
}

// ── SIPClient ─────────────────────────────────────────────────────────────────

class SIPClient extends EventEmitter {
  constructor({ host, port = 5060, username, password, localIp }) {
    super();
    this.host     = host;
    this.port     = parseInt(port);
    this.username = username;
    this.password = password;
    this.localIp  = localIp;
    this.socket   = null;
    this.registered = false;

    this._pending  = new Map(); // callId → callback
    this._regTimer = null;
  }

  start() {
    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const firstLine = text.split('\r\n')[0];
      console.log(`[SIP ← ${rinfo.address}:${rinfo.port}] ${firstLine}`);
      try {
        const parsed = parseSIP(msg);
        this._dispatch(parsed);
      } catch (e) {
        console.warn('[SIP] Parse error:', e.message);
      }
    });

    this.socket.on('error', (e) => console.error('[SIP] Socket error:', e.message));

    this.socket.bind(5060, '0.0.0.0', () => {
      console.log('[SIP] Socket UDP aberto na porta 5060');
      this._register();
    });
  }

  // ── REGISTER ───────────────────────────────────────────────────────────────

  _register(authLine = null) {
    const callId  = uuid();
    const fromTag = uuid().replace(/-/g, '').slice(0, 8);
    const branch  = 'z9hG4bK' + uuid().replace(/-/g, '').slice(0, 12);

    const msg = buildSIPRequest({
      method:     'REGISTER',
      requestUri: `sip:${this.host}`,
      headers: {
        localIp:  this.localIp,
        username: this.username,
        host:     this.host,
        fromTag,
        toUser:   this.username,
        callId,
        cseq:     1,
        branch,
        expires:  3600,
        authorization: authLine,
      },
    });

    this._send(msg, callId, (res) => {
      if (res.status === 401) {
        const www = this._parseAuth(res.headers['www-authenticate']);
        if (!www) return;
        const response = digestResponse({
          method: 'REGISTER', uri: `sip:${this.host}`,
          realm: www.realm, nonce: www.nonce,
          username: this.username, password: this.password,
        });
        const auth = `Digest username="${this.username}",realm="${www.realm}",nonce="${www.nonce}",uri="sip:${this.host}",response="${response}",algorithm=MD5`;
        this._register(auth);
        return;
      }

      if (res.status === 200) {
        if (!this.registered) {
          this.registered = true;
          console.log('[SIP] Registrado no WaVoIP ✅');
          this.emit('registered');
        }
        this._regTimer = setTimeout(() => this._register(), 50 * 60 * 1000);
      } else {
        console.error(`[SIP] REGISTER falhou: ${res.status} ${res.reason}`);
        setTimeout(() => this._register(), 30000);
      }
    });
  }

  // ── INVITE (chamada outbound) ───────────────────────────────────────────────

  call(destination, rtpPort, onConnected, onHangup) {
    const callId  = uuid();
    const fromTag = uuid().replace(/-/g, '').slice(0, 8);
    const sdp     = buildSDP(this.localIp, rtpPort);

    const doInvite = (authLine = null, cseq = 1) => {
      const branch = 'z9hG4bK' + uuid().replace(/-/g, '').slice(0, 12);

      const msg = buildSIPRequest({
        method:     'INVITE',
        requestUri: `sip:${destination}@${this.host}`,
        headers: {
          localIp:  this.localIp,
          username: this.username,
          host:     this.host,
          fromTag,
          toUser:   destination,
          callId,
          cseq,
          branch,
          authorization: authLine,
        },
        body: sdp,
      });

      this._pending.set(callId, (res) => {
        // Provisórios: continua aguardando
        if (res.status === 100 || res.status === 180 || res.status === 183) {
          console.log(`[SIP] Chamando ${destination}... (${res.status})`);
          return; // mantém listener
        }

        // Desafio de autenticação
        if (res.status === 401 || res.status === 407) {
          this._pending.delete(callId);
          const www = this._parseAuth(
            res.headers['www-authenticate'] || res.headers['proxy-authenticate']
          );
          if (!www) return;
          const uri = `sip:${destination}@${this.host}`;
          const response = digestResponse({
            method: 'INVITE', uri,
            realm: www.realm, nonce: www.nonce,
            username: this.username, password: this.password,
          });
          const auth = `Digest username="${this.username}",realm="${www.realm}",nonce="${www.nonce}",uri="${uri}",response="${response}",algorithm=MD5`;
          doInvite(auth, cseq + 1);
          return;
        }

        // Chamada atendida
        if (res.status === 200) {
          this._pending.delete(callId);
          console.log(`[SIP] ✅ Chamada atendida: ${destination}`);

          const { ip, port, codec } = parseSDP(res.content);

          const toHeader    = res.headers['to'] || '';
          const toTagMatch  = toHeader.match(/tag=([^\s;]+)/);
          const toTag       = toTagMatch ? toTagMatch[1] : '';

          // ACK
          const ackBranch = 'z9hG4bK' + uuid().replace(/-/g, '').slice(0, 12);
          const ack = buildSIPRequest({
            method:     'ACK',
            requestUri: `sip:${destination}@${this.host}`,
            headers: {
              localIp:  this.localIp,
              username: this.username,
              host:     this.host,
              fromTag,
              toUser:   destination,
              toTag,
              callId,
              cseq,
              branch:   ackBranch,
            },
          });
          this._sendRaw(ack);

          // Salva dados da sessão ativa para BYE posterior
          this._pending.set('active:' + callId, { destination, fromTag, toTag, cseq, onHangup });

          if (ip && port) onConnected({ remoteIp: ip, remotePort: port, codec });
          return;
        }

        // Falha
        this._pending.delete(callId);
        console.error(`[SIP] Chamada falhou: ${res.status} ${res.reason}`);
        if (onHangup) onHangup(res.status);
      });

      this._sendRaw(msg);
      console.log(`[SIP] Iniciando chamada → ${destination}`);
    };

    doInvite();
  }

  // ── Dispatch ───────────────────────────────────────────────────────────────

  _dispatch(msg) {
    // Trata BYE recebido (chamada encerrada pelo remoto)
    if (msg.method === 'BYE') {
      const callId = msg.headers['call-id'];
      console.log('[SIP] BYE recebido — chamada encerrada pelo remoto');

      // Responde 200 OK ao BYE com headers espelhados
      const response = buildSIPResponse({
        status: 200, reason: 'OK',
        reqHeaders: msg.headers,
      });
      this._sendRaw(response);

      // Notifica via onHangup (fechamento limpo via closure da sessão)
      const active = this._pending.get('active:' + callId);
      if (active?.onHangup) active.onHangup('bye');

      // Limpa pendentes
      this._pending.delete(callId);
      this._pending.delete('active:' + callId);

      this.emit('bye', callId);
      return;
    }

    // Trata respostas (status codes)
    if (msg.status) {
      const callId = msg.headers['call-id'];
      const cb = this._pending.get(callId);
      if (cb) cb(msg);
      // Provisórios (1xx) mantêm o callback; finais (2xx+) são removidos dentro do próprio callback
    }
  }

  // ── Envio ──────────────────────────────────────────────────────────────────

  _send(msg, callId, callback) {
    this._pending.set(callId, callback);
    this._sendRaw(msg);
  }

  _sendRaw(msg) {
    const buf = Buffer.from(msg);
    const firstLine = msg.split('\r\n')[0];
    console.log(`[SIP → ${this.host}:${this.port}] ${firstLine}`);
    this.socket.send(buf, 0, buf.length, this.port, this.host, (err) => {
      if (err) console.error('[SIP] Erro ao enviar:', err.message);
    });
  }

  _parseAuth(header = '') {
    const realm = header.match(/realm="([^"]+)"/)?.[1];
    const nonce = header.match(/nonce="([^"]+)"/)?.[1];
    if (!realm || !nonce) return null;
    return { realm, nonce };
  }

  stop() {
    if (this._regTimer) clearTimeout(this._regTimer);
    try { this.socket?.close(); } catch {}
  }
}

module.exports = SIPClient;
